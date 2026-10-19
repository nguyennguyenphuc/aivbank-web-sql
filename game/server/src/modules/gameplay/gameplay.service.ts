import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ContentService } from '../content/content.service.js';
import { createEngineDefinition } from '../content/engine-definition.js';
import type { ReplayCapture, RunRecord, ServerMoveLog } from './gameplay-types.js';
import { ReplayValidatorService } from './replay-validator.service.js';
import { RunTokenService } from './run-token.service.js';
import { CompetitionMetaService } from '../competition/competition-meta.service.js';
import { CompetitionService } from '../competition/competition.service.js';
import { LiveOpsService } from '../liveops/liveops.service.js';
import { PlayerService } from '../player/player.service.js';
import { EconomyService } from '../economy/economy.service.js';
import { DatabaseService } from '../../database/database.service.js';

@Injectable()
export class GameplayService {
  private readonly runs = new Map<string, RunRecord>();
  private readonly captures = new Map<string, ReplayCapture>();

  constructor(
    @Inject(ContentService) private readonly content: ContentService,
    @Inject(RunTokenService) private readonly tokens: RunTokenService,
    @Inject(ReplayValidatorService) private readonly validator: ReplayValidatorService,
    @Inject(PlayerService) private readonly players: PlayerService,
    @Inject(CompetitionService) private readonly competition: CompetitionService,
    @Inject(CompetitionMetaService) private readonly competitionMeta: CompetitionMetaService,
    @Inject(LiveOpsService) private readonly liveOps: LiveOpsService,
    @Inject(EconomyService) private readonly economy: EconomyService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async start(input: { playerId?: string; levelId?: number; contentRevision?: string; appVersion?: string }): Promise<unknown> {
    if (!input.playerId?.trim()) throw new BadRequestException('playerId is required');
    if (input.playerId.length > 128) throw new BadRequestException('playerId is too long');
    if (input.appVersion && input.appVersion.length > 32) throw new BadRequestException('appVersion is too long');
    this.pruneExpiredRuns();
    if (this.runs.size >= 10_000) throw new ConflictException('Too many active runs');
    const levelId = Number(input.levelId);
    const revision = input.contentRevision ?? 'content.v2.1.1';
    const level = this.content.getLevel(revision, levelId, input.appVersion);
    const runId = randomUUID();
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const seed = mixSeed(level.seed, input.playerId, runId);
    const engine = createEngineDefinition(levelId, seed);
    const run: RunRecord = {
      runId, playerId: input.playerId, levelId, contentRevision: level.revision,
      seed, appVersion: input.appVersion ?? 'unknown', expiresAt, submitted: false,
      boardConfig: engine.board, objectives: engine.objectives, moveBudget: engine.moveBudget,
    };
    this.runs.set(runId, run);
    await this.database.query(
      `insert into gameplay_runs (run_id, player_id, level_id, content_revision, seed, app_version, expires_at, board_config, objectives, move_budget)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
      [run.runId, run.playerId, run.levelId, run.contentRevision, run.seed, run.appVersion, run.expiresAt, JSON.stringify(run.boardConfig), JSON.stringify(run.objectives), run.moveBudget],
    );
    const runToken = this.tokens.sign({
      runId: run.runId,
      playerId: run.playerId,
      levelId: run.levelId,
      contentRevision: run.contentRevision,
      seed: run.seed,
      expiresAt: run.expiresAt,
    });
    return { runId, seed, levelId, contentRevision: run.contentRevision, runToken, expiresAt, engine };
  }

  async submit(
    input: { runId?: string; runToken?: string; moves?: ServerMoveLog[]; claimedScore?: number; claimedWon?: boolean },
    authenticatedPlayerId?: string,
  ): Promise<unknown> {
    if (!input.runId || !input.runToken || !Array.isArray(input.moves)) throw new BadRequestException('runId, runToken, and moves are required');
    if (input.moves.length > 200) throw new BadRequestException('Move log exceeds 200 entries');
    if (!Number.isSafeInteger(input.claimedScore) || Number(input.claimedScore) < 0) throw new BadRequestException('claimedScore must be a non-negative integer');
    const payload = this.tokens.verify(input.runToken);
    const run = await this.loadRun(input.runId);
    if (!run || payload.runId !== run.runId || payload.playerId !== run.playerId || payload.seed !== run.seed) {
      throw new UnauthorizedException('Run token does not match run');
    }
    if (!authenticatedPlayerId || authenticatedPlayerId !== run.playerId) {
      throw new UnauthorizedException('Run belongs to a different player');
    }
    if (run.submitted) throw new ConflictException('Run already submitted');
    if (input.moves.length > run.moveBudget) throw new BadRequestException('Move log exceeds level move budget');
    const replay = this.validator.replay(run.boardConfig, run.objectives, input.moves);
    const won = replay.valid && replay.objectives.every(objective => objective.current >= objective.target);
    const suspicious = !replay.valid || input.claimedScore !== replay.score || Boolean(input.claimedWon) !== won;
    if (suspicious) await this.capture(run, input.moves, replay.reason ?? 'Claim differs from authoritative replay', replay.replayDigest);
    const accepted = replay.valid && !suspicious;
    if (accepted) await this.recordVerifiedOutcome(run, replay.score, won);
    run.submitted = true;
    await this.database.query('update gameplay_runs set submitted = true, submitted_at = now() where run_id = $1 and not submitted', [run.runId]);
    return {
      accepted, suspicious, authoritativeScore: replay.score,
      authoritativeWon: won, finalBoardHash: replay.finalBoardHash, reason: suspicious ? (replay.reason ?? 'Claim mismatch') : undefined,
    };
  }

  private async recordVerifiedOutcome(run: RunRecord, score: number, won: boolean): Promise<void> {
    const achievedAt = new Date().toISOString();
    const player = await this.players.restore(run.playerId);
    await this.players.applyVerifiedOutcome(run.playerId, run.runId, run.levelId, score, won);
    try {
      await this.liveOps.recordVerifiedProgress(run.playerId, `gameplay:${run.runId}:played`, 'levels_played', 1, achievedAt, 'server-event');
      if (won) {
        await this.liveOps.recordVerifiedProgress(run.playerId, `gameplay:${run.runId}:won`, 'levels_won', 1, achievedAt, 'server-event');
      }
    } catch (error) {
      // A missing or temporarily unavailable calendar must not invalidate an already verified run.
      if (!(error instanceof Error) || !('status' in error) || (error as { status?: number }).status !== 404) throw error;
    }
    await this.competitionMeta.applyOutcome(run.playerId, {
      won,
      endless: run.levelId > 60,
      verification: 'server-replay',
      eventId: `gameplay:${run.runId}`,
    });
    if (won) {
      const softReward = Math.min(500, 50 + Math.floor(score / 100));
      await this.economy.grant(
        run.playerId,
        [{ currency: 'soft', amount: softReward }],
        'verified_level_win',
        run.runId,
        `gameplay-reward:${run.playerId}:${run.runId}`,
        `gameplay-reward:${run.playerId}:${run.runId}`,
      );
    }
    const classroomMemberships = await this.database.query<{
      [key: string]: unknown; classroom_id: string; roster_revision: string;
    }>(
      `select c.classroom_id, c.roster_revision from teaching_classrooms c
       join teaching_classroom_members m on m.classroom_id = c.classroom_id
       where m.account_id = $1 and m.role = 'student'`,
      [run.playerId],
    );
    await this.competition.recordVerifiedScore({
      playerId: run.playerId,
      runId: run.runId,
      score,
      achievedAt,
      ranked: true,
      verification: 'server-replay',
      suspicious: false,
    }, {
      playerId: run.playerId,
      publicName: player.displayName,
      classroomMemberships: classroomMemberships.map(row => ({ classroomId: row.classroom_id, rosterRevision: row.roster_revision })),
    });
  }

  async getCapture(runId: string): Promise<ReplayCapture> {
    let capture = this.captures.get(runId);
    if (!capture) {
      const rows = await this.database.query<{ [key: string]: unknown; payload: ReplayCapture }>('select payload from gameplay_replay_captures where run_id = $1', [runId]);
      capture = rows[0]?.payload;
    }
    if (!capture) throw new BadRequestException('Replay capture not found');
    return capture;
  }

  private async capture(run: RunRecord, moves: readonly ServerMoveLog[], reason: string, replayDigest: string): Promise<void> {
    if (this.captures.size >= 1_000) this.captures.delete(this.captures.keys().next().value as string);
    const capture = Object.freeze({
      runId: run.runId, capturedAt: new Date().toISOString(), reason, seed: run.seed,
      contentRevision: run.contentRevision, moves: Object.freeze(moves.map(move => Object.freeze({ ...move }))), replayDigest,
    });
    this.captures.set(run.runId, capture);
    await this.database.query(
      `insert into gameplay_replay_captures (run_id, payload, captured_at) values ($1, $2::jsonb, $3)
       on conflict (run_id) do nothing`,
      [run.runId, JSON.stringify(capture), capture.capturedAt],
    );
  }

  private async loadRun(runId: string): Promise<RunRecord | undefined> {
    const cached = this.runs.get(runId);
    if (cached) return cached;
    const rows = await this.database.query<{
      [key: string]: unknown; run_id: string; player_id: string; level_id: number; content_revision: string;
      seed: string; app_version: string; expires_at: Date; submitted: boolean; board_config: RunRecord['boardConfig'];
      objectives: RunRecord['objectives']; move_budget: number;
    }>('select * from gameplay_runs where run_id = $1', [runId]);
    const row = rows[0];
    if (!row) return undefined;
    const run: RunRecord = {
      runId: row.run_id, playerId: row.player_id, levelId: row.level_id, contentRevision: row.content_revision,
      seed: Number(row.seed), appVersion: row.app_version, expiresAt: row.expires_at.toISOString(), submitted: row.submitted,
      boardConfig: row.board_config, objectives: row.objectives, moveBudget: row.move_budget,
    };
    this.runs.set(runId, run);
    return run;
  }

  private pruneExpiredRuns(): void {
    const now = Date.now();
    for (const [runId, run] of this.runs) if (Date.parse(run.expiresAt) <= now || run.submitted) this.runs.delete(runId);
  }
}

function mixSeed(base: number, playerId: string, runId: string): number {
  const hash = createHash('sha256').update(`${base}:${playerId}:${runId}`).digest();
  return hash.readUInt32BE(0);
}
