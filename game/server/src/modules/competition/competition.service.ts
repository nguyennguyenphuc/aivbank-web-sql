import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type {
  LeaderboardEntry, LeaderboardPage, LeaderboardScope, RankedPlayerContext, SeasonSnapshot, VerifiedRankedScore,
} from '../../../../shared/contracts/competition/index.js';
import { COMPETITION_REPOSITORY, type CompetitionRepository, type StoredLeaderboardEntry } from './competition.repository.js';
import { LEADERBOARD_CACHE, type CachedRank, type LeaderboardCache } from './leaderboard-cache.js';
import { leaderboardNamespace } from './leaderboard-namespace.js';

@Injectable()
export class CompetitionService {
  constructor(
    @Inject(COMPETITION_REPOSITORY) private readonly repository: CompetitionRepository,
    @Inject(LEADERBOARD_CACHE) private readonly cache: LeaderboardCache,
  ) {}

  async registerRoster(classroomId: string, rosterRevision: string, playerIds: readonly string[]): Promise<void> {
    if (playerIds.length > 10_000 || playerIds.some(id => !id.trim())) throw new BadRequestException('Invalid classroom roster');
    await this.repository.registerRoster(classroomId, rosterRevision, [...new Set(playerIds)]);
  }

  async recordVerifiedScore(
    result: VerifiedRankedScore,
    player: RankedPlayerContext,
    activeSeasonId?: string,
  ): Promise<LeaderboardScope[]> {
    validateVerifiedResult(result, player);
    const scopes: LeaderboardScope[] = [{ kind: 'global' }];
    if (player.countryCode) scopes.push({ kind: 'country', countryCode: player.countryCode.toUpperCase() });
    if (activeSeasonId) {
      if (await this.repository.isSeasonClosed(activeSeasonId)) throw new ConflictException('Season is closed');
      scopes.push({ kind: 'season', seasonId: activeSeasonId });
    }
    for (const membership of player.classroomMemberships) {
      if (await this.repository.isRosterMember(membership.classroomId, membership.rosterRevision, player.playerId)) {
        scopes.push({ kind: 'classroom', ...membership });
      }
    }
    const entry: StoredLeaderboardEntry = {
      playerId: player.playerId,
      displayName: player.publicName.trim().slice(0, 40),
      score: result.score,
      achievedAt: result.achievedAt,
    };
    for (const scope of scopes) {
      const stored = await this.repository.upsert(scope, entry, result.runId);
      await this.tryCache(scope, stored);
    }
    return scopes;
  }

  async top(scope: LeaderboardScope, viewerId: string, limit = 50): Promise<LeaderboardPage> {
    await this.authorizeScope(scope, viewerId);
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const cached = await this.readCache(scope, () => this.cache.top(leaderboardNamespace(scope), safeLimit));
    const entries = cached.length ? await this.hydrate(scope, cached) : await this.rebuild(scope, safeLimit);
    return { scope: structuredClone(scope), entries, generatedAt: new Date().toISOString() };
  }

  async around(scope: LeaderboardScope, viewerId: string, radius = 2): Promise<LeaderboardPage> {
    await this.authorizeScope(scope, viewerId);
    const safeRadius = Math.min(10, Math.max(0, Math.trunc(radius)));
    let cached = await this.readCache(scope, () => this.cache.around(leaderboardNamespace(scope), viewerId, safeRadius));
    if (!cached.length) {
      await this.rebuild(scope, Number.MAX_SAFE_INTEGER);
      cached = await this.readCache(scope, () => this.cache.around(leaderboardNamespace(scope), viewerId, safeRadius));
    }
    const entries = cached.length ? await this.hydrate(scope, cached) : await this.aroundFromRepository(scope, viewerId, safeRadius);
    return { scope: structuredClone(scope), entries, generatedAt: new Date().toISOString() };
  }

  async topForAuthorizedStaff(scope: Extract<LeaderboardScope, { kind: 'classroom' }>, limit = 50): Promise<LeaderboardPage> {
    leaderboardNamespace(scope);
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const entries = await this.rebuild(scope, safeLimit);
    return { scope: structuredClone(scope), entries, generatedAt: new Date().toISOString() };
  }

  async closeSeason(seasonId: string, closedAt: string): Promise<SeasonSnapshot> {
    if (!Number.isFinite(Date.parse(closedAt))) throw new BadRequestException('closedAt must be an ISO date');
    return this.repository.snapshotSeason(seasonId, closedAt);
  }

  private async authorizeScope(scope: LeaderboardScope, viewerId: string): Promise<void> {
    leaderboardNamespace(scope);
    if (scope.kind === 'classroom' && !await this.repository.isRosterMember(scope.classroomId, scope.rosterRevision, viewerId)) {
      throw new ForbiddenException('Classroom leaderboard is restricted to its exact roster revision');
    }
  }

  private async rebuild(scope: LeaderboardScope, limit: number): Promise<LeaderboardEntry[]> {
    const rows = await this.repository.list(scope);
    for (const row of rows) await this.tryCache(scope, row);
    return rows.slice(0, limit).map((row, index) => ({ ...row, rank: index + 1 }));
  }

  private async hydrate(scope: LeaderboardScope, ranks: CachedRank[]): Promise<LeaderboardEntry[]> {
    const entries: LeaderboardEntry[] = [];
    for (const rank of ranks) {
      const row = await this.repository.get(scope, rank.playerId);
      if (row) entries.push({ ...row, score: rank.score, rank: rank.rank });
    }
    return entries;
  }

  private async aroundFromRepository(scope: LeaderboardScope, playerId: string, radius: number): Promise<LeaderboardEntry[]> {
    const rows = await this.repository.list(scope);
    const index = rows.findIndex(row => row.playerId === playerId);
    if (index < 0) return [];
    const start = Math.max(0, index - radius);
    return rows.slice(start, index + radius + 1).map((row, offset) => ({ ...row, rank: start + offset + 1 }));
  }

  private async tryCache(scope: LeaderboardScope, entry: StoredLeaderboardEntry): Promise<void> {
    try { await this.cache.put(leaderboardNamespace(scope), entry.playerId, entry.score); } catch { /* cache is rebuildable */ }
  }

  private async readCache(scope: LeaderboardScope, read: () => Promise<CachedRank[]>): Promise<CachedRank[]> {
    try { return await read(); } catch { return []; }
  }
}

function validateVerifiedResult(result: VerifiedRankedScore, player: RankedPlayerContext): void {
  if (result.playerId !== player.playerId || result.verification !== 'server-replay' || !result.ranked || result.suspicious) {
    throw new BadRequestException('Only verified non-suspicious ranked results are accepted');
  }
  if (!Number.isSafeInteger(result.score) || result.score < 0) throw new BadRequestException('score must be a non-negative safe integer');
  if (!result.runId.trim() || !player.publicName.trim() || !Number.isFinite(Date.parse(result.achievedAt))) {
    throw new BadRequestException('Invalid ranked result metadata');
  }
}
