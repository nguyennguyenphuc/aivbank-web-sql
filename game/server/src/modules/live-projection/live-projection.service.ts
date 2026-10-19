import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { TelemetryIngestEvent } from '../../../../shared/contracts/telemetry/index.js';
import type { AppEnv } from '../../config/env.js';
import { APP_ENV, DatabaseService } from '../../database/database.service.js';

/**
 * Projects live AIV Bank players into the `jelly_analytics` teaching tables.
 *
 * Every live key carries the `aivb_` prefix and every live row uses
 * `app_version = 'web-live'`, so the synthetic cohorts (2.0.2/2.1.0/2.1.1) and
 * their teaching signals stay intact, and the dataset importer can replace the
 * synthetic rows without deleting live ones.
 *
 * Projection is best effort: a failure is logged and never rejects the
 * authoritative write (telemetry spine, purchase, ad reward) that triggered it.
 */
export const LIVE_APP_VERSION = 'web-live';
export const LIVE_CHANNEL = 'AIV Bank';
const LIVE_TIME_ZONE = 'Asia/Ho_Chi_Minh';

export interface BrowserContext {
  userAgent?: string | string[];
  acceptLanguage?: string | string[];
}

interface LiveUser {
  [key: string]: unknown;
  user_id: string;
  platform: string;
  country: string;
}

const BOOSTER_TYPES: Record<string, string> = {
  hammer: 'lollipop_hammer',
  shuffle: 'sweet_shuffle',
  lightning: 'striped_candy',
  extraMoves: 'extra_moves',
};

const DAILY_TRIGGERS = new Set(['level_started', 'level_completed', 'booster_used']);

const AD_PLACEMENTS: Record<string, { placement: string; rewardType: string }> = {
  'defeat-extra-moves': { placement: 'level_fail_reward', rewardType: 'booster' },
  'daily-coins': { placement: 'daily_reward', rewardType: 'coins' },
};

export function platformFromUserAgent(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && /mobile/i.test(ua))) return 'iOS';
  return 'Web';
}

export function deviceTierFromUserAgent(userAgent: string | undefined): string {
  return /mobi|android|iphone|ipad|ipod/i.test(userAgent ?? '') ? 'mobile' : 'desktop';
}

/** First language tag carrying a region wins (`vi-VN` -> `VN`); Vietnamese without a region is VN. */
export function countryFromAcceptLanguage(acceptLanguage: string | undefined): string {
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.split(';')[0]?.trim() ?? '';
    const region = /^[a-z]{2,3}[-_]([a-z]{2})$/i.exec(tag)?.[1];
    if (region) return region.toUpperCase();
    if (/^vi$/i.test(tag)) return 'VN';
  }
  return 'VN';
}

/** `2026-09-28T14:03:05` in Vietnam local time, the format of the synthetic tables. */
export function localDateTime(instant: string | Date): { date: string; time: string } {
  const text = new Date(instant).toLocaleString('sv-SE', { timeZone: LIVE_TIME_ZONE, hour12: false });
  const [date, time] = text.split(' ');
  return { date, time: `${date}T${time}` };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hashId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
}

@Injectable()
export class LiveProjectionService {
  private readonly logger = new Logger(LiveProjectionService.name);
  private readonly enabled: boolean;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_ENV) env: AppEnv,
  ) {
    this.enabled = !(env.USE_FAKE_INTEGRATIONS === 1 || env.NODE_ENV === 'test');
  }

  /** One accepted `game_observation` from the H5 client. */
  async observation(accountId: string, event: TelemetryIngestEvent, context: BrowserContext = {}): Promise<void> {
    if (event.eventName !== 'game_observation') return;
    await this.run('observation', accountId, context, async (client, user) => {
      const payload = event.payload as {
        sessionId: string; elapsedMs: number;
        attempt: { id: string; levelId: number; mode: string } | null;
        observation: Record<string, unknown> & { type: string };
      };
      const at = localDateTime(event.occurredAt);
      const sessionId = `aivb_s_${payload.sessionId}`;
      await this.upsertSession(client, user, sessionId, at, payload.elapsedMs);
      if (!payload.attempt) return this.refreshDaily(client, user.user_id, at.date);

      const attemptId = `aivb_a_${payload.attempt.id}`;
      const observation = payload.observation;
      const movesLeft = typeof observation.movesLeft === 'number' ? observation.movesLeft : null;
      if (observation.type === 'level_started') {
        // A new start abandons whatever this player left running.
        await client.query(
          `update jelly_analytics.level_attempts set result = 'quit'
            where user_id = $1 and result = 'in_progress' and attempt_id <> $2`,
          [user.user_id, attemptId],
        );
      }
      await client.query(
        `insert into jelly_analytics.level_attempts (attempt_id, user_id, event_date, event_time, session_id, level_id,
           episode, world_name, screen_context, objective_type, difficulty_tag, moves_limit, moves_used, moves_left,
           result, booster_used, extra_moves_offered, extra_moves_purchased, duration_sec, app_version, platform, country)
         select $1, $2, $3, $4, $5, $6, m.episode, m.world_name, $7, m.objective_type, m.difficulty_tag,
                $8, case when $8::text is null then null else '0' end, $8,
                'in_progress', '0', '0', '0', '0', $9, $10, $11
           from (select 1) one left join jelly_analytics.level_metadata m on m.level_id = $6
         on conflict (attempt_id) do nothing`,
        [attemptId, user.user_id, at.date, at.time, sessionId, String(payload.attempt.levelId),
          `AIV Bank > ${payload.attempt.mode} > Level ${payload.attempt.levelId}`,
          observation.type === 'level_started' && movesLeft !== null ? String(movesLeft) : null,
          LIVE_APP_VERSION, user.platform, user.country],
      );

      if ((observation.type === 'move_resolved' || observation.type === 'booster_resolved') && movesLeft !== null) {
        await client.query(
          `update jelly_analytics.level_attempts
              set moves_left = $2::text,
                  moves_used = case when moves_limit is null then null else greatest(moves_limit::int - $2::text::int, 0)::text end
            where attempt_id = $1`,
          [attemptId, String(movesLeft)],
        );
      }
      if (observation.type === 'booster_used' && typeof observation.booster === 'string') {
        const extraMoves = observation.booster === 'extraMoves';
        await client.query(
          `insert into jelly_analytics.booster_events (booster_event_id, attempt_id, user_id, event_date, event_time,
             session_id, level_id, booster_type, action, screen_context, app_version, platform, country)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'use', 'Level board > booster tray', $9, $10, $11)
           on conflict (booster_event_id) do nothing`,
          [`aivb_b_${event.eventId}`, attemptId, user.user_id, at.date, at.time, sessionId, String(payload.attempt.levelId),
            BOOSTER_TYPES[observation.booster] ?? observation.booster, LIVE_APP_VERSION, user.platform, user.country],
        );
        await client.query(
          `update jelly_analytics.level_attempts set booster_used = '1',
             extra_moves_offered = case when $2 then '1' else extra_moves_offered end,
             extra_moves_purchased = case when $2 then '1' else extra_moves_purchased end
           where attempt_id = $1`,
          [attemptId, extraMoves],
        );
      }
      if (observation.type === 'level_completed') {
        await client.query(
          `update jelly_analytics.level_attempts
              set result = $2,
                  duration_sec = greatest(0, round(extract(epoch from ($3::timestamp - event_time::timestamp))))::int::text
            where attempt_id = $1`,
          [attemptId, observation.won === true ? 'complete' : 'fail_out_of_moves', at.time],
        );
      }
      // Per-move observations only touch the attempt row; daily rollups follow the milestones.
      if (DAILY_TRIGGERS.has(observation.type)) await this.refreshDaily(client, user.user_id, at.date);
    });
  }

  /** A settled cash purchase, a refund of one, or a soft-currency shop purchase. */
  async purchase(accountId: string, input: {
    key: string; productId: string; priceCents: number; currency: string; refund?: boolean; occurredAt?: string;
  }): Promise<void> {
    await this.run('purchase', accountId, {}, async (client, user) => {
      const at = localDateTime(input.occurredAt ?? new Date());
      const usd = input.currency === 'USD' ? (input.priceCents / 100).toFixed(2) : '0';
      await client.query(
        `insert into jelly_analytics.purchases (transaction_id, user_id, event_date, event_time, session_id, product_type,
           product_name, price_usd, level_id_if_relevant, screen_context, currency, is_refund, app_version, platform, country)
         values ($1, $2, $3, $4, (select session_id from jelly_analytics.sessions where user_id = $2 order by event_time desc limit 1),
                 $5, $6, $7, null, 'Shop screen', $8, $9, $10, $11, $12)
         on conflict (transaction_id) do nothing`,
        [`aivb_t_${hashId(accountId, input.key, input.refund ? 'refund' : 'sale')}`, user.user_id, at.date, at.time,
          input.productId.replaceAll('-', '_'), input.productId, usd, input.currency, input.refund ? '1' : '0',
          LIVE_APP_VERSION, user.platform, user.country],
      );
      await this.refreshDaily(client, user.user_id, at.date);
    });
  }

  /** A completed rewarded ad. The sandbox provider pays nothing, so revenue is 0. */
  async adReward(accountId: string, input: { tokenId: string; placement: string; occurredAt?: string }): Promise<void> {
    await this.run('ad', accountId, {}, async (client, user) => {
      const at = localDateTime(input.occurredAt ?? new Date());
      const mapped = AD_PLACEMENTS[input.placement] ?? { placement: input.placement, rewardType: 'coins' };
      await client.query(
        `insert into jelly_analytics.ad_events (ad_id, user_id, event_date, event_time, session_id, ad_type, placement,
           reward_type, revenue_usd, screen_context, app_version, platform, country)
         values ($1, $2, $3, $4, (select session_id from jelly_analytics.sessions where user_id = $2 order by event_time desc limit 1),
                 'rewarded', $5, $6, '0', $7, $8, $9, $10)
         on conflict (ad_id) do nothing`,
        [`aivb_ad_${input.tokenId}`, user.user_id, at.date, at.time, mapped.placement, mapped.rewardType,
          `Ad popup > ${mapped.placement}`, LIVE_APP_VERSION, user.platform, user.country],
      );
      await this.refreshDaily(client, user.user_id, at.date);
    });
  }

  private async run(kind: string, accountId: string, context: BrowserContext,
    work: (client: PoolClient, user: LiveUser) => Promise<void>): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.database.withClient(async client => {
        await client.query('begin');
        try {
          const user = await this.ensureUser(client, accountId, context);
          if (user) await work(client, user);
          await client.query('commit');
        } catch (error) {
          await client.query('rollback');
          throw error;
        }
      });
    } catch (error) {
      this.logger.warn(`live ${kind} projection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Only AIV Bank identities are projected; guests and other providers are skipped. */
  private async ensureUser(client: PoolClient, accountId: string, context: BrowserContext): Promise<LiveUser | undefined> {
    const { rows: [identity] } = await client.query<{ user_id: string; install_date: string }>(
      `select 'aivb_' || i.provider_subject user_id,
              to_char(a.created_at at time zone '${LIVE_TIME_ZONE}', 'YYYY-MM-DD') install_date
         from account_identities i join accounts a on a.account_id = i.account_id
        where i.account_id = $1 and i.provider = 'aivb' and i.deleted_at is null
        limit 1`,
      [accountId],
    );
    if (!identity) return undefined;
    // Serialise concurrent projections of one player (session/daily upserts are read-modify-write).
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [identity.user_id]);
    const userAgent = first(context.userAgent);
    const known = userAgent !== undefined;
    const { rows: [user] } = await client.query<LiveUser>(
      `insert into jelly_analytics.users (user_id, install_date, platform, country, channel, campaign_id, app_version_install, device_tier)
       values ($1, $2, $3, $4, $5, null, $6, $7)
       on conflict (user_id) do update set
         platform = case when $8 then excluded.platform else users.platform end,
         country = case when $8 then excluded.country else users.country end,
         device_tier = case when $8 then excluded.device_tier else users.device_tier end
       returning user_id, platform, country`,
      [identity.user_id, identity.install_date, platformFromUserAgent(userAgent),
        countryFromAcceptLanguage(first(context.acceptLanguage)), LIVE_CHANNEL, LIVE_APP_VERSION,
        deviceTierFromUserAgent(userAgent), known],
    );
    return user;
  }

  private async upsertSession(client: PoolClient, user: LiveUser, sessionId: string,
    at: { date: string; time: string }, elapsedMs: number): Promise<void> {
    const minutes = String(Math.max(1, Math.ceil(elapsedMs / 60_000)));
    await client.query(
      `insert into jelly_analytics.sessions (session_id, user_id, session_start, event_date, event_time,
         duration_minutes, entry_screen, app_version, platform, country)
       values ($1, $2, $3, $4, $3, $5, 'aivbank', $6, $7, $8)
       on conflict (session_id) do update
         set duration_minutes = greatest(sessions.duration_minutes::int, excluded.duration_minutes::int)::text`,
      [sessionId, user.user_id, at.time, at.date, minutes, LIVE_APP_VERSION, user.platform, user.country],
    );
  }

  /** Rebuilds this player's `player_daily` row and, on live-only days, the `daily_kpi` row. */
  private async refreshDaily(client: PoolClient, userId: string, date: string): Promise<void> {
    await client.query('delete from jelly_analytics.player_daily where user_id = $1 and activity_date = $2', [userId, date]);
    await client.query(
      `insert into jelly_analytics.player_daily (user_id, install_date, activity_date, cohort_day, platform, country,
         channel, campaign_id, app_version, sessions, playtime_minutes, max_level, boosters_used,
         extra_moves_purchased, crash_count, iap_revenue, ad_revenue)
       select u.user_id, u.install_date, $2::text, ($2::text::date - u.install_date::date)::text, u.platform, u.country,
              u.channel, u.campaign_id, $3::text,
              (select count(*) from jelly_analytics.sessions s where s.user_id = u.user_id and s.event_date = $2::text)::text,
              (select coalesce(sum(s.duration_minutes::int), 0) from jelly_analytics.sessions s
                where s.user_id = u.user_id and s.event_date = $2::text)::text,
              (select coalesce(max(a.level_id::int) filter (where a.result = 'complete'), 0) from jelly_analytics.level_attempts a
                where a.user_id = u.user_id and a.event_date = $2::text)::text,
              (select count(*) from jelly_analytics.booster_events b where b.user_id = u.user_id and b.event_date = $2::text)::text,
              (select count(*) from jelly_analytics.level_attempts a
                where a.user_id = u.user_id and a.event_date = $2::text and a.extra_moves_purchased = '1')::text,
              '0',
              (select coalesce(sum(case when p.is_refund = '1' then -p.price_usd::numeric else p.price_usd::numeric end), 0)
                 from jelly_analytics.purchases p where p.user_id = u.user_id and p.event_date = $2::text)::text,
              (select coalesce(sum(e.revenue_usd::numeric), 0) from jelly_analytics.ad_events e
                where e.user_id = u.user_id and e.event_date = $2::text)::text
         from jelly_analytics.users u where u.user_id = $1::text`,
      [userId, date, LIVE_APP_VERSION],
    );
    // Never touch a KPI day inside the synthetic dataset's data window.
    const synthetic = `exists (select 1 from jelly_analytics.dataset_metadata m
                               where $1::text between m.manifest->'data_window'->>'start' and m.manifest->'data_window'->>'end')`;
    await client.query(`delete from jelly_analytics.daily_kpi where date = $1::text and not ${synthetic}`, [date]);
    await client.query(
      `insert into jelly_analytics.daily_kpi (date, dau, new_users, sessions, playtime_minutes, iap_revenue, ad_revenue, crash_count, arpdau)
       select $1::text, count(distinct user_id)::text, count(*) filter (where cohort_day = '0')::text,
              sum(sessions::int)::text, sum(playtime_minutes::int)::text,
              sum(iap_revenue::numeric)::text, sum(ad_revenue::numeric)::text, '0',
              round((sum(iap_revenue::numeric) + sum(ad_revenue::numeric)) / count(distinct user_id), 4)::text
         from jelly_analytics.player_daily
        where activity_date = $1::text and user_id like 'aivb\\_%' and not ${synthetic}
       having count(*) > 0`,
      [date],
    );
  }
}
