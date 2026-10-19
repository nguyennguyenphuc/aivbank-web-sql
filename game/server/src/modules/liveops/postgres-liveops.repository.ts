import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { InboxMessage, LiveOpsCalendar, PlayerQuestState } from '../../../../shared/contracts/liveops/index.js';
import { DatabaseService } from '../../database/database.service.js';
import type { LiveOpsRepository } from './liveops.repository.js';

interface CalendarRow { [key: string]: unknown; revision: string; payload: LiveOpsCalendar }
interface ProgressRow { [key: string]: unknown; quest_id: string; progress: number; claimed: boolean }
interface InboxRow { [key: string]: unknown; message_id: string; payload: InboxMessage; claimed: boolean }

@Injectable()
export class PostgresLiveOpsRepository implements LiveOpsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async publishCalendar(calendar: LiveOpsCalendar): Promise<void> {
    const current = await this.database.query<CalendarRow>('select revision, payload from liveops_calendars where revision = $1', [calendar.revision]);
    if (current[0] && JSON.stringify(current[0].payload) !== JSON.stringify(calendar)) throw new ConflictException('Calendar revisions are immutable');
    await this.database.query(
      'insert into liveops_calendars (revision, payload, published_at) values ($1, $2::jsonb, $3) on conflict do nothing',
      [calendar.revision, JSON.stringify(calendar), calendar.publishedAt],
    );
  }

  async activateCalendar(revision: string, expectedRevision?: string): Promise<void> {
    await this.database.withClient(async client => {
      await client.query('begin');
      try {
        const active = await client.query<{ revision: string }>('select revision from liveops_calendars where active for update');
        if (expectedRevision !== undefined && active.rows[0]?.revision !== expectedRevision) throw new ConflictException('Active calendar changed');
        const target = await client.query('select revision from liveops_calendars where revision = $1', [revision]);
        if (!target.rowCount) throw new NotFoundException('Calendar revision not found');
        await client.query('update liveops_calendars set active = false where active');
        await client.query('update liveops_calendars set active = true where revision = $1', [revision]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    });
  }

  async activeCalendar(): Promise<LiveOpsCalendar | undefined> {
    const rows = await this.database.query<CalendarRow>('select revision, payload from liveops_calendars where active');
    return rows[0] ? structuredClone(rows[0].payload) : undefined;
  }

  async incrementQuest(playerId: string, questId: string, amount: number, target: number): Promise<PlayerQuestState> {
    const rows = await this.database.query<ProgressRow>(
      `insert into liveops_quest_progress (player_id, quest_id, progress) values ($1, $2, least($3::integer, $4::integer))
       on conflict (player_id, quest_id) do update set progress = least($4::integer, liveops_quest_progress.progress + $3::integer), updated_at = now()
       returning quest_id, progress, claimed`,
      [playerId, questId, amount, target],
    );
    return readProgress(rows[0], target);
  }

  async applyProgressEvent(playerId: string, eventId: string, updates: Array<{ questId: string; amount: number; target: number }>): Promise<boolean> {
    return this.database.withClient(async client => {
      await client.query('begin');
      try {
        const event = await client.query(
          'insert into liveops_progress_events (player_id, event_id) values ($1, $2) on conflict do nothing returning event_id',
          [playerId, eventId],
        );
        if (!event.rowCount) { await client.query('commit'); return false; }
        for (const update of updates) {
          await client.query(
            `insert into liveops_quest_progress (player_id, quest_id, progress) values ($1, $2, least($3::integer, $4::integer))
             on conflict (player_id, quest_id) do update set progress = least($4::integer, liveops_quest_progress.progress + $3::integer), updated_at = now()`,
            [playerId, update.questId, update.amount, update.target],
          );
        }
        await client.query('commit');
        return true;
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    });
  }

  async questState(playerId: string, questId: string, target: number): Promise<PlayerQuestState> {
    const rows = await this.database.query<ProgressRow>(
      'select quest_id, progress, claimed from liveops_quest_progress where player_id = $1 and quest_id = $2',
      [playerId, questId],
    );
    return rows[0] ? readProgress(rows[0], target) : { questId, progress: 0, target, claimable: false, claimed: false };
  }

  async claimQuest(playerId: string, questId: string, target: number): Promise<PlayerQuestState> {
    const rows = await this.database.query<ProgressRow>(
      `update liveops_quest_progress set claimed = true, updated_at = now()
       where player_id = $1 and quest_id = $2 and progress >= $3 and not claimed returning quest_id, progress, claimed`,
      [playerId, questId, target],
    );
    if (!rows[0]) throw new ConflictException('Quest is incomplete or already claimed');
    return readProgress(rows[0], target);
  }

  async publishInbox(message: InboxMessage): Promise<void> {
    const existing = await this.database.query<{ [key: string]: unknown; payload: InboxMessage }>('select payload from liveops_inbox where message_id = $1', [message.messageId]);
    if (existing[0] && JSON.stringify(existing[0].payload) !== JSON.stringify(message)) throw new ConflictException('Inbox messages are immutable');
    await this.database.query(
      `insert into liveops_inbox (message_id, account_id, payload, available_at, expires_at)
       values ($1, $2, $3::jsonb, $4, $5) on conflict do nothing`,
      [message.messageId, message.accountId ?? null, JSON.stringify(message), message.availableAt, message.expiresAt],
    );
  }

  async inbox(playerId: string): Promise<Array<InboxMessage & { claimed: boolean }>> {
    const rows = await this.database.query<InboxRow>(
      `select i.message_id, i.payload, (c.message_id is not null) claimed from liveops_inbox i
       left join liveops_inbox_claims c on c.message_id = i.message_id and c.player_id = $1
       where i.account_id is null or i.account_id = $1 order by i.available_at, i.message_id`,
      [playerId],
    );
    return rows.map(row => ({ ...structuredClone(row.payload), claimed: row.claimed }));
  }

  async claimInbox(playerId: string, messageId: string): Promise<void> {
    const rows = await this.database.query(
      `insert into liveops_inbox_claims (player_id, message_id)
       select $1, message_id from liveops_inbox where message_id = $2 and (account_id is null or account_id = $1)
       on conflict do nothing returning message_id`,
      [playerId, messageId],
    );
    if (!rows.length) throw new ConflictException('Inbox reward unavailable or already claimed');
  }

  async lastSeen(playerId: string): Promise<string | undefined> {
    const rows = await this.database.query<{ [key: string]: unknown; last_seen_at: Date }>('select last_seen_at from liveops_player_state where player_id = $1', [playerId]);
    return rows[0]?.last_seen_at.toISOString();
  }

  async setLastSeen(playerId: string, at: string): Promise<void> {
    await this.database.query(
      `insert into liveops_player_state (player_id, last_seen_at) values ($1, $2)
       on conflict (player_id) do update set last_seen_at = greatest(liveops_player_state.last_seen_at, excluded.last_seen_at)`,
      [playerId, at],
    );
  }
}

function readProgress(row: ProgressRow, target: number): PlayerQuestState {
  return { questId: row.quest_id, progress: row.progress, target, claimable: row.progress >= target && !row.claimed, claimed: row.claimed };
}
