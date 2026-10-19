import { describe, expect, it, vi } from 'vitest';
import { ContentService } from '../../server/src/modules/content/content.service.js';
import { GameplayService } from '../../server/src/modules/gameplay/gameplay.service.js';
import { ReplayValidatorService } from '../../server/src/modules/gameplay/replay-validator.service.js';
import { RunTokenService } from '../../server/src/modules/gameplay/run-token.service.js';
import { applyMove, createBoard, findPossibleMove, type BoardConfig, type EngineObjective } from '../../shared/engine';

describe('server-authoritative gameplay runs', () => {
  const createService = () => {
    const effects = {
      players: {
        restore: vi.fn(async (accountId: string) => ({ accountId, displayName: 'Test Player' })),
        applyVerifiedOutcome: vi.fn(async (accountId: string) => ({ accountId, displayName: 'Test Player' })),
      },
      competition: { recordVerifiedScore: vi.fn(async () => [{ kind: 'global' }]) },
      meta: { applyOutcome: vi.fn(async () => ({ currentStreak: 1 })) },
      liveops: { recordVerifiedProgress: vi.fn(async () => undefined) },
      economy: { grant: vi.fn(async () => ({ accountId: 'player', soft: 50, hard: 0, inventory: {}, revision: 1 })) },
      database: { query: vi.fn(async (sql: string) => sql.includes('teaching_classrooms') ? [{ classroom_id: 'class-1', roster_revision: 'roster-1' }] : []) },
    };
    return {
      service: new GameplayService(
        new ContentService(), new RunTokenService('test-secret'), new ReplayValidatorService(),
        effects.players as never, effects.competition as never, effects.meta as never, effects.liveops as never, effects.economy as never, effects.database as never,
      ),
      effects,
    };
  };

  it('signs a run and accepts a deterministic empty replay exactly once', async () => {
    const { service, effects } = createService();
    const started = await service.start({
      playerId: 'player-1', levelId: 1, contentRevision: 'content.v2.1.1', appVersion: 'v2.1.1',
    }) as { runId: string; runToken: string };
    const result = await service.submit({
      runId: started.runId, runToken: started.runToken, moves: [], claimedScore: 0, claimedWon: false,
    }, 'player-1');
    expect(result).toMatchObject({ accepted: true, suspicious: false, authoritativeScore: 0 });
    expect(effects.competition.recordVerifiedScore).toHaveBeenCalledOnce();
    expect(effects.competition.recordVerifiedScore).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ classroomMemberships: [{ classroomId: 'class-1', rosterRevision: 'roster-1' }] }),
    );
    expect(effects.players.applyVerifiedOutcome).toHaveBeenCalledOnce();
    await expect(service.submit({
      runId: started.runId, runToken: started.runToken, moves: [], claimedScore: 0, claimedWon: false,
    }, 'player-1')).rejects.toThrow(/already submitted/i);
  });

  it('captures tampered claims with seed and immutable move log', async () => {
    const { service, effects } = createService();
    const started = await service.start({ playerId: 'player-2', levelId: 2 }) as { runId: string; runToken: string };
    await expect(service.submit({
      runId: started.runId, runToken: started.runToken, moves: [], claimedScore: 99, claimedWon: true,
    }, 'player-2')).resolves.toMatchObject({ accepted: false, suspicious: true });
    expect(effects.competition.recordVerifiedScore).not.toHaveBeenCalled();
    await expect(service.getCapture(started.runId)).resolves.toMatchObject({ runId: started.runId, seed: expect.any(Number), moves: [] });
  });

  it('recomputes browser moves through the shared engine instead of trusting client score', async () => {
    const { service } = createService();
    const started = await service.start({ playerId: 'player-parity', levelId: 2 }) as {
      runId: string;
      runToken: string;
      engine: { board: BoardConfig; objectives: EngineObjective[] };
    };
    const board = createBoard(started.engine.board);
    const move = findPossibleMove(board)!;
    const turn = applyMove(board, move, started.engine.objectives, started.engine.board.colors, 0);
    const result = await service.submit({
      runId: started.runId,
      runToken: started.runToken,
      moves: [turn.record!],
      claimedScore: turn.scoreDelta,
      claimedWon: turn.objectives.every(objective => objective.current >= objective.target),
    }, 'player-parity');
    expect(result).toMatchObject({ accepted: true, authoritativeScore: turn.scoreDelta });
  });

  it('restores an active run from PostgreSQL-shaped persistence after a service restart', async () => {
    let persisted: Record<string, unknown> | undefined;
    const database = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('insert into gameplay_runs')) {
          persisted = {
            run_id: params[0], player_id: params[1], level_id: params[2], content_revision: params[3], seed: String(params[4]),
            app_version: params[5], expires_at: new Date(String(params[6])), submitted: false,
            board_config: JSON.parse(String(params[7])), objectives: JSON.parse(String(params[8])), move_budget: params[9],
          };
        }
        if (sql.includes('select * from gameplay_runs')) return persisted ? [persisted] : [];
        if (sql.includes('update gameplay_runs') && persisted) persisted.submitted = true;
        return [];
      }),
    };
    const dependencies = () => ({
      players: { restore: vi.fn(async () => ({ displayName: 'Persistent Player' })), applyVerifiedOutcome: vi.fn(async () => undefined) },
      competition: { recordVerifiedScore: vi.fn(async () => []) },
      meta: { applyOutcome: vi.fn(async () => undefined) },
      liveops: { recordVerifiedProgress: vi.fn(async () => undefined) },
      economy: { grant: vi.fn(async () => undefined) },
    });
    const first = dependencies();
    const serviceBeforeRestart = new GameplayService(
      new ContentService(), new RunTokenService('persistent-secret'), new ReplayValidatorService(),
      first.players as never, first.competition as never, first.meta as never, first.liveops as never, first.economy as never, database as never,
    );
    const started = await serviceBeforeRestart.start({ playerId: 'player-persistent', levelId: 1 }) as { runId: string; runToken: string };

    const second = dependencies();
    const serviceAfterRestart = new GameplayService(
      new ContentService(), new RunTokenService('persistent-secret'), new ReplayValidatorService(),
      second.players as never, second.competition as never, second.meta as never, second.liveops as never, second.economy as never, database as never,
    );
    await expect(serviceAfterRestart.submit({
      runId: started.runId, runToken: started.runToken, moves: [], claimedScore: 0, claimedWon: false,
    }, 'player-persistent')).resolves.toMatchObject({ accepted: true, suspicious: false });
    expect(persisted?.submitted).toBe(true);
  });
});
