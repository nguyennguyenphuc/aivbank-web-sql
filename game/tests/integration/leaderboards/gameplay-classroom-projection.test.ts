import { describe, expect, it, vi } from 'vitest';
import { ContentService } from '../../../server/src/modules/content/content.service.js';
import { GameplayService } from '../../../server/src/modules/gameplay/gameplay.service.js';
import { ReplayValidatorService } from '../../../server/src/modules/gameplay/replay-validator.service.js';
import { RunTokenService } from '../../../server/src/modules/gameplay/run-token.service.js';
import { InMemoryCompetitionRepository } from '../../../server/src/modules/competition/competition.repository.js';
import { CompetitionService } from '../../../server/src/modules/competition/competition.service.js';
import { InMemoryLeaderboardCache } from '../../../server/src/modules/competition/leaderboard-cache.js';

describe('gameplay classroom leaderboard projection', () => {
  it('projects a replay-verified run into the current authoritative classroom roster', async () => {
    const competition = new CompetitionService(new InMemoryCompetitionRepository(), new InMemoryLeaderboardCache());
    await competition.registerRoster('class-1', 'roster-1', ['player-1']);
    const database = {
      query: vi.fn(async (sql: string) => sql.includes('teaching_classrooms')
        ? [{ classroom_id: 'class-1', roster_revision: 'roster-1' }]
        : []),
    };
    const gameplay = new GameplayService(
      new ContentService(),
      new RunTokenService('classroom-projection-secret'),
      new ReplayValidatorService(),
      {
        restore: vi.fn(async () => ({ displayName: 'Student One' })),
        applyVerifiedOutcome: vi.fn(async () => undefined),
      } as never,
      competition,
      { applyOutcome: vi.fn(async () => undefined) } as never,
      { recordVerifiedProgress: vi.fn(async () => undefined) } as never,
      { grant: vi.fn(async () => undefined) } as never,
      database as never,
    );

    const started = await gameplay.start({ playerId: 'player-1', levelId: 1 }) as { runId: string; runToken: string };
    await gameplay.submit({
      runId: started.runId,
      runToken: started.runToken,
      moves: [],
      claimedScore: 0,
      claimedWon: false,
    }, 'player-1');

    const board = await competition.top({ kind: 'classroom', classroomId: 'class-1', rosterRevision: 'roster-1' }, 'player-1');
    expect(board.entries).toEqual([expect.objectContaining({ playerId: 'player-1', displayName: 'Student One', score: 0 })]);
  });
});
