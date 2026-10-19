import { Inject, Injectable } from '@nestjs/common';
import type { CompetitionMetaState, LeagueTier } from '../../../../shared/contracts/competition/index.js';
import { DatabaseService } from '../../database/database.service.js';
import type { CompetitionMetaRepository } from './competition-meta.repository.js';

interface MetaRow {
  [key: string]: unknown;
  player_id: string; current_streak: number; best_streak: number; shields: number;
  league: LeagueTier; league_points: number; endless_level: number; revision: number;
}

@Injectable()
export class PostgresCompetitionMetaRepository implements CompetitionMetaRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async get(playerId: string): Promise<CompetitionMetaState | undefined> {
    const rows = await this.database.query<MetaRow>('select * from competition_meta where player_id = $1', [playerId]);
    return rows[0] ? readMeta(rows[0]) : undefined;
  }

  async save(state: CompetitionMetaState, expectedRevision: number): Promise<void> {
    const rows = await this.database.query<MetaRow>(
      `insert into competition_meta (player_id, current_streak, best_streak, shields, league, league_points, endless_level, revision)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (player_id) do update set current_streak = excluded.current_streak, best_streak = excluded.best_streak,
       shields = excluded.shields, league = excluded.league, league_points = excluded.league_points,
       endless_level = excluded.endless_level, revision = excluded.revision, updated_at = now()
       where competition_meta.revision = $9 returning *`,
      [state.playerId, state.currentStreak, state.bestStreak, state.shields, state.league, state.leaguePoints, state.endlessLevel, state.revision, expectedRevision],
    );
    if (!rows.length) throw new Error('Competition meta revision conflict');
  }

  async saveOutcome(state: CompetitionMetaState, expectedRevision: number, eventId: string): Promise<boolean> {
    return this.database.withClient(async client => {
      await client.query('begin');
      try {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`competition-meta:${state.playerId}`]);
        const outcome = await client.query(
          `insert into competition_meta_outcomes (player_id, event_id) values ($1, $2)
           on conflict do nothing returning event_id`,
          [state.playerId, eventId],
        );
        if (!outcome.rowCount) {
          await client.query('commit');
          return false;
        }
        const saved = await client.query(
          `insert into competition_meta (player_id, current_streak, best_streak, shields, league, league_points, endless_level, revision)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (player_id) do update set current_streak = excluded.current_streak, best_streak = excluded.best_streak,
           shields = excluded.shields, league = excluded.league, league_points = excluded.league_points,
           endless_level = excluded.endless_level, revision = excluded.revision, updated_at = now()
           where competition_meta.revision = $9 returning player_id`,
          [state.playerId, state.currentStreak, state.bestStreak, state.shields, state.league, state.leaguePoints, state.endlessLevel, state.revision, expectedRevision],
        );
        if (!saved.rowCount) throw new Error('Competition meta revision conflict');
        await client.query('commit');
        return true;
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    });
  }
}

function readMeta(row: MetaRow): CompetitionMetaState {
  return {
    playerId: row.player_id, currentStreak: row.current_streak, bestStreak: row.best_streak,
    shields: row.shields, league: row.league, leaguePoints: row.league_points,
    endlessLevel: row.endless_level, revision: row.revision,
  };
}
