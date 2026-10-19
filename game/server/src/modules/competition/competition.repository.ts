import { ConflictException, Injectable } from '@nestjs/common';
import type { LeaderboardEntry, LeaderboardScope, SeasonSnapshot } from '../../../../shared/contracts/competition/index.js';
import { leaderboardNamespace } from './leaderboard-namespace.js';

export interface StoredLeaderboardEntry extends Omit<LeaderboardEntry, 'rank'> {}

export interface CompetitionRepository {
  registerRoster(classroomId: string, rosterRevision: string, playerIds: readonly string[]): Promise<void>;
  isRosterMember(classroomId: string, rosterRevision: string, playerId: string): Promise<boolean>;
  upsert(scope: LeaderboardScope, entry: StoredLeaderboardEntry, runId: string): Promise<StoredLeaderboardEntry>;
  list(scope: LeaderboardScope): Promise<StoredLeaderboardEntry[]>;
  get(scope: LeaderboardScope, playerId: string): Promise<StoredLeaderboardEntry | undefined>;
  isSeasonClosed(seasonId: string): Promise<boolean>;
  snapshotSeason(seasonId: string, closedAt: string): Promise<SeasonSnapshot>;
}

export const COMPETITION_REPOSITORY = Symbol('COMPETITION_REPOSITORY');

@Injectable()
export class InMemoryCompetitionRepository implements CompetitionRepository {
  private readonly boards = new Map<string, Map<string, StoredLeaderboardEntry>>();
  private readonly operations = new Set<string>();
  private readonly rosters = new Map<string, ReadonlySet<string>>();
  private readonly snapshots = new Map<string, SeasonSnapshot>();
  private readonly closedSeasons = new Set<string>();

  async registerRoster(classroomId: string, rosterRevision: string, playerIds: readonly string[]): Promise<void> {
    const key = `${classroomId}:${rosterRevision}`;
    const next = new Set(playerIds);
    const current = this.rosters.get(key);
    if (current && !sameMembers(current, next)) throw new ConflictException('Roster revisions are immutable');
    this.rosters.set(key, next);
  }

  async isRosterMember(classroomId: string, rosterRevision: string, playerId: string): Promise<boolean> {
    return this.rosters.get(`${classroomId}:${rosterRevision}`)?.has(playerId) ?? false;
  }

  async upsert(scope: LeaderboardScope, entry: StoredLeaderboardEntry, runId: string): Promise<StoredLeaderboardEntry> {
    const namespace = leaderboardNamespace(scope);
    const operation = `${namespace}:${runId}`;
    const board = this.boards.get(namespace) ?? new Map<string, StoredLeaderboardEntry>();
    const current = board.get(entry.playerId);
    if (!this.operations.has(operation) && (!current || entry.score > current.score)) board.set(entry.playerId, structuredClone(entry));
    this.operations.add(operation);
    this.boards.set(namespace, board);
    return structuredClone(board.get(entry.playerId) ?? entry);
  }

  async list(scope: LeaderboardScope): Promise<StoredLeaderboardEntry[]> {
    return this.sorted(leaderboardNamespace(scope)).map(entry => structuredClone(entry));
  }

  async get(scope: LeaderboardScope, playerId: string): Promise<StoredLeaderboardEntry | undefined> {
    const entry = this.boards.get(leaderboardNamespace(scope))?.get(playerId);
    return entry ? structuredClone(entry) : undefined;
  }

  async isSeasonClosed(seasonId: string): Promise<boolean> { return this.closedSeasons.has(seasonId); }

  async snapshotSeason(seasonId: string, closedAt: string): Promise<SeasonSnapshot> {
    const existing = this.snapshots.get(seasonId);
    if (existing) return structuredClone(existing);
    const entries = this.sorted(leaderboardNamespace({ kind: 'season', seasonId }))
      .map((entry, index) => ({ ...entry, rank: index + 1 }));
    const snapshot: SeasonSnapshot = { snapshotId: `season:${seasonId}:${closedAt}`, seasonId, closedAt, entries };
    this.snapshots.set(seasonId, structuredClone(snapshot));
    this.closedSeasons.add(seasonId);
    return snapshot;
  }

  private sorted(namespace: string): StoredLeaderboardEntry[] {
    return [...(this.boards.get(namespace)?.values() ?? [])]
      .sort((a, b) => b.score - a.score || a.playerId.localeCompare(b.playerId));
  }
}

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every(value => b.has(value));
}
