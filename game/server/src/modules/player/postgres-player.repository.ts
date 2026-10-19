import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import type { PlayerRepository } from './player.repository.js';
import type { PlayerSnapshot, PracticeResult } from './player.types.js';

interface PlayerDbRow {
  [key: string]: unknown;
  account_id: string;
  display_name: string;
  sound: boolean;
  music: boolean;
  reduced_motion: boolean;
  locale: string;
  unlocked_level: number;
  stars_earned: number;
  total_score: string;
  last_level_id: number;
  revision: number;
  updated_at: Date;
}

@Injectable()
export class PostgresPlayerRepository implements PlayerRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async find(accountId: string): Promise<PlayerSnapshot | undefined> {
    const rows = await this.database.query<PlayerDbRow>(
      `select p.account_id, p.display_name, s.sound, s.music, s.reduced_motion, s.locale,
       g.unlocked_level, g.stars_earned, g.total_score, g.last_level_id, g.revision,
       greatest(p.updated_at, s.updated_at, g.updated_at) as updated_at
       from player_profiles p join player_settings s using (account_id)
       join player_progress_snapshots g using (account_id) where p.account_id = $1`,
      [accountId],
    );
    const row = rows[0];
    return row ? {
      accountId: row.account_id,
      displayName: row.display_name,
      settings: { sound: row.sound, music: row.music, reducedMotion: row.reduced_motion, locale: row.locale },
      progress: { unlockedLevel: row.unlocked_level, starsEarned: row.stars_earned, totalScore: Number(row.total_score), lastLevelId: row.last_level_id, revision: row.revision },
      updatedAt: row.updated_at.toISOString(),
    } : undefined;
  }

  async save(snapshot: PlayerSnapshot, expectedProgressRevision?: number): Promise<void> {
    await this.database.withClient(async client => {
      await client.query('begin');
      try {
        await client.query(
          `insert into player_profiles (account_id, display_name, updated_at) values ($1, $2, $3)
           on conflict (account_id) do update set display_name = excluded.display_name, updated_at = excluded.updated_at`,
          [snapshot.accountId, snapshot.displayName, snapshot.updatedAt],
        );
        await client.query(
          `insert into player_settings (account_id, sound, music, reduced_motion, locale, updated_at)
           values ($1, $2, $3, $4, $5, $6) on conflict (account_id) do update set sound = excluded.sound,
           music = excluded.music, reduced_motion = excluded.reduced_motion, locale = excluded.locale, updated_at = excluded.updated_at`,
          [snapshot.accountId, snapshot.settings.sound, snapshot.settings.music, snapshot.settings.reducedMotion, snapshot.settings.locale, snapshot.updatedAt],
        );
        const progressValues = [snapshot.accountId, snapshot.progress.unlockedLevel, snapshot.progress.starsEarned, snapshot.progress.totalScore, snapshot.progress.lastLevelId, snapshot.progress.revision, snapshot.updatedAt];
        if (expectedProgressRevision === undefined) {
          await client.query(
            `insert into player_progress_snapshots (account_id, unlocked_level, stars_earned, total_score, last_level_id, revision, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7) on conflict (account_id) do nothing`, progressValues,
          );
        } else {
          const updated = await client.query(
            `update player_progress_snapshots set unlocked_level = $2, stars_earned = $3, total_score = $4,
             last_level_id = $5, revision = $6, updated_at = $7 where account_id = $1 and revision = $8`,
            [...progressValues, expectedProgressRevision],
          );
          if (updated.rowCount !== 1) throw new ConflictException('Progress revision conflict');
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    });
  }

  async savePractice(accountId: string, result: PracticeResult): Promise<boolean> {
    const rows = await this.database.query<{ [key: string]: unknown; operation_id: string }>(
      `insert into offline_practice_operations (account_id, operation_id, level_id, score, stars)
       values ($1, $2, $3, $4, $5) on conflict do nothing returning operation_id`,
      [accountId, result.operationId, result.levelId, result.score, result.stars],
    );
    return rows.length === 1;
  }

  async hasPractice(accountId: string, operationId: string): Promise<boolean> {
    const rows = await this.database.query<{ [key: string]: unknown; operation_id: string }>('select operation_id from offline_practice_operations where account_id = $1 and operation_id = $2', [accountId, operationId]);
    return rows.length === 1;
  }

  async applyVerifiedOutcome(accountId: string, runId: string, levelId: number, score: number, won: boolean): Promise<boolean> {
    return this.database.withClient(async client => {
      await client.query('begin');
      try {
        const inserted = await client.query(
          `insert into gameplay_progress_events (run_id, account_id, level_id, score, won)
           values ($1, $2, $3, $4, $5) on conflict (run_id) do nothing returning run_id`,
          [runId, accountId, levelId, score, won],
        );
        if (inserted.rowCount === 1) {
          await client.query(
            `update player_progress_snapshots set
               unlocked_level = case when $4 then greatest(unlocked_level, $2 + 1) else unlocked_level end,
               stars_earned = stars_earned + case when $4 then 1 else 0 end,
               total_score = total_score + $3,
               last_level_id = $2,
               revision = revision + 1,
               updated_at = now()
             where account_id = $1`,
            [accountId, levelId, score, won],
          );
        }
        await client.query('commit');
        return inserted.rowCount === 1;
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    });
  }
}
