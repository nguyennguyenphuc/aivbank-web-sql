import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { LeaderboardScope, SeasonSnapshot } from '../../../../shared/contracts/competition/index.js';
import { DatabaseService } from '../../database/database.service.js';
import type { CompetitionRepository, StoredLeaderboardEntry } from './competition.repository.js';
import { leaderboardNamespace } from './leaderboard-namespace.js';

interface EntryRow {
  [key: string]: unknown;
  player_id: string;
  display_name: string;
  score: string;
  achieved_at: Date;
}

interface SnapshotRow {
  [key: string]: unknown;
  snapshot_id: string;
  season_id: string;
  closed_at: Date;
  entries: SeasonSnapshot['entries'];
}

@Injectable()
export class PostgresCompetitionRepository implements CompetitionRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async registerRoster(classroomId: string, rosterRevision: string, playerIds: readonly string[]): Promise<void> {
    await this.database.withClient(async client => {
      await client.query('begin');
      try {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`${classroomId}:${rosterRevision}`]);
        const revision = await client.query(
          'select roster_revision from competition_roster_revisions where classroom_id = $1 and roster_revision = $2 for update',
          [classroomId, rosterRevision],
        );
        const current = await client.query<{ player_id: string }>(
          'select player_id from competition_rosters where classroom_id = $1 and roster_revision = $2 order by player_id',
          [classroomId, rosterRevision],
        );
        const next = [...new Set(playerIds)].sort();
        if (revision.rowCount && current.rows.map(row => row.player_id).join('\0') !== next.join('\0')) {
          throw new ConflictException('Roster revisions are immutable');
        }
        await client.query(
          'insert into competition_roster_revisions (classroom_id, roster_revision) values ($1, $2) on conflict do nothing',
          [classroomId, rosterRevision],
        );
        for (const playerId of next) {
          await client.query(
            'insert into competition_rosters (classroom_id, roster_revision, player_id) values ($1, $2, $3) on conflict do nothing',
            [classroomId, rosterRevision, playerId],
          );
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    });
  }

  async isRosterMember(classroomId: string, rosterRevision: string, playerId: string): Promise<boolean> {
    const rows = await this.database.query(
      'select 1 from competition_rosters where classroom_id = $1 and roster_revision = $2 and player_id = $3',
      [classroomId, rosterRevision, playerId],
    );
    return rows.length === 1;
  }

  async upsert(scope: LeaderboardScope, entry: StoredLeaderboardEntry, runId: string): Promise<StoredLeaderboardEntry> {
    const namespace = leaderboardNamespace(scope);
    await this.database.query(
      `insert into competition_leaderboard_entries (namespace, player_id, display_name, score, achieved_at, source_run_id)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (namespace, player_id) do update set display_name = excluded.display_name,
       score = excluded.score, achieved_at = excluded.achieved_at, source_run_id = excluded.source_run_id, updated_at = now()
       where excluded.score > competition_leaderboard_entries.score`,
      [namespace, entry.playerId, entry.displayName, entry.score, entry.achievedAt, runId],
    );
    return (await this.get(scope, entry.playerId)) ?? entry;
  }

  async list(scope: LeaderboardScope): Promise<StoredLeaderboardEntry[]> {
    const rows = await this.database.query<EntryRow>(
      'select player_id, display_name, score, achieved_at from competition_leaderboard_entries where namespace = $1 order by score desc, player_id',
      [leaderboardNamespace(scope)],
    );
    return rows.map(readEntry);
  }

  async get(scope: LeaderboardScope, playerId: string): Promise<StoredLeaderboardEntry | undefined> {
    const rows = await this.database.query<EntryRow>(
      'select player_id, display_name, score, achieved_at from competition_leaderboard_entries where namespace = $1 and player_id = $2',
      [leaderboardNamespace(scope), playerId],
    );
    return rows[0] ? readEntry(rows[0]) : undefined;
  }

  async isSeasonClosed(seasonId: string): Promise<boolean> {
    const rows = await this.database.query('select 1 from competition_seasons where season_id = $1 and status = $2', [seasonId, 'closed']);
    return rows.length === 1;
  }

  async snapshotSeason(seasonId: string, closedAt: string): Promise<SeasonSnapshot> {
    return this.database.withClient(async client => {
      await client.query('begin');
      try {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`season:${seasonId}`]);
        const existing = await this.readSnapshot(client, seasonId);
        if (existing) { await client.query('commit'); return existing; }
        const rows = await client.query<EntryRow>(
          'select player_id, display_name, score, achieved_at from competition_leaderboard_entries where namespace = $1 order by score desc, player_id',
          [leaderboardNamespace({ kind: 'season', seasonId })],
        );
        const entries = rows.rows.map((row, index) => ({ ...readEntry(row), rank: index + 1 }));
        const snapshotId = `season:${seasonId}:${closedAt}`;
        await client.query(
          'insert into competition_season_snapshots (snapshot_id, season_id, closed_at, entries) values ($1, $2, $3, $4::jsonb)',
          [snapshotId, seasonId, closedAt, JSON.stringify(entries)],
        );
        await client.query(
          `insert into competition_seasons (season_id, status, closed_at) values ($1, 'closed', $2)
           on conflict (season_id) do update set status = 'closed', closed_at = excluded.closed_at`,
          [seasonId, closedAt],
        );
        await client.query('commit');
        return { snapshotId, seasonId, closedAt, entries };
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    });
  }

  private async readSnapshot(client: PoolClient, seasonId: string): Promise<SeasonSnapshot | undefined> {
    const result = await client.query<SnapshotRow>('select * from competition_season_snapshots where season_id = $1', [seasonId]);
    const row = result.rows[0];
    return row ? { snapshotId: row.snapshot_id, seasonId: row.season_id, closedAt: row.closed_at.toISOString(), entries: row.entries } : undefined;
  }
}

function readEntry(row: EntryRow): StoredLeaderboardEntry {
  return { playerId: row.player_id, displayName: row.display_name, score: Number(row.score), achievedAt: row.achieved_at.toISOString() };
}
