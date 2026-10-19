import { BadRequestException, ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { TeachingAnalyticsSnapshot, TelemetryIngestEvent } from '../../../../shared/contracts/telemetry/index.js';
import { APP_ENV, DatabaseService } from '../../database/database.service.js';
import type { AppEnv } from '../../config/env.js';
import { type BrowserContext, LiveProjectionService } from '../live-projection/live-projection.service.js';

@Injectable()
export class AnalyticsService {
  private readonly hashSecret: string;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_ENV) env: AppEnv,
    @Optional() @Inject(LiveProjectionService) private readonly projection?: LiveProjectionService,
  ) {
    if (env.NODE_ENV === 'production' && !env.TELEMETRY_HASH_SECRET) throw new Error('TELEMETRY_HASH_SECRET is required in production');
    this.hashSecret = env.TELEMETRY_HASH_SECRET ?? env.SESSION_SECRET ?? 'local-telemetry-hash-secret';
  }

  async ingest(accountId: string, event: TelemetryIngestEvent, context: BrowserContext = {}): Promise<{ accepted: boolean; duplicate: boolean }> {
    validateEvent(event);
    const playerHash = createHmac('sha256', this.hashSecret).update(accountId).digest('hex');
    const params = [event.eventId, playerHash, event.eventName, event.schemaVersion, event.occurredAt, JSON.stringify(event.payload), event.source];
    const inserted = await this.database.query(
      `insert into analytics_event_spine (event_id, player_hash, event_name, schema_version, occurred_at, payload, source)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)
       on conflict (event_id) do nothing returning event_id`,
      params,
    );
    if (inserted.length) {
      // Only the first delivery is projected, so client retries never double-count.
      await this.projection?.observation(accountId, event, context);
      return { accepted: true, duplicate: false };
    }
    // A separate statement sees the committed winner after ON CONFLICT waits for a concurrent insert.
    // PostgreSQL compares JSONB structurally (object key order is immaterial) and timestamps by instant.
    const [existing] = await this.database.query<{ [key: string]: unknown; player_hash: string; same_content: boolean }>(
      `select player_hash, (player_hash = $2 and event_name = $3 and schema_version = $4
        and occurred_at = $5::timestamptz and payload = $6::jsonb and source = $7) as same_content
       from analytics_event_spine where event_id = $1`,
      params,
    );
    if (!existing || existing.player_hash !== playerHash || !existing.same_content) {
      throw new ConflictException('Telemetry event id was reused with different content or owner');
    }
    return { accepted: true, duplicate: true };
  }

  async teachingSnapshot(): Promise<TeachingAnalyticsSnapshot> {
    return this.database.withClient(async client => {
      await client.query('begin');
      try {
        await client.query("set local lock_timeout = '10s'");
        // Hold source locks across every read: TRUNCATE is not MVCC-safe, and the
        // importer must publish its manifest and all teaching tables together.
        await client.query('lock table jelly_analytics.tutorial_steps, jelly_analytics.level_attempts, jelly_analytics.daily_kpi, jelly_analytics.dataset_metadata in share mode');
        const { rows: tutorial } = await client.query<{ app_version: string; platform: string; region: string; completion_rate: string; rows: string }>(
          'select * from jelly_analytics.tutorial_step4_health order by region, platform, app_version',
        );
        const { rows: friction } = await client.query<{ app_version: string; platform: string; region: string; win_rate: string; non_complete_rate: string; attempts: string }>(
          'select * from jelly_analytics.level_28_30_health where attempts >= 50 order by region, platform, app_version',
        );
        const { rows: daily } = await client.query<{ date: string; dau: string; sessions: string; arpdau: string }>(
          'select date, dau, sessions, arpdau from jelly_analytics.daily_kpi order by date',
        );
        const { rows: [metadata] } = await client.query<{ manifest: { dataset_version: string; synthetic: boolean; tables: Record<string, number> }; imported_at: Date | string }>(
          'select manifest, imported_at from jelly_analytics.dataset_metadata limit 1',
        );
        const snapshot: TeachingAnalyticsSnapshot = {
          dataset: metadata ? {
            version: metadata.manifest.dataset_version,
            synthetic: metadata.manifest.synthetic,
            totalRows: Object.values(metadata.manifest.tables).reduce((sum, rows) => sum + rows, 0),
            importedAt: new Date(metadata.imported_at).toISOString(),
          } : null,
          tutorialStep4: tutorial.map(row => ({ appVersion: row.app_version, platform: row.platform, region: row.region, completionRate: Number(row.completion_rate), rows: Number(row.rows) })),
          levelFriction: friction.map(row => ({ appVersion: row.app_version, platform: row.platform, region: row.region, winRate: Number(row.win_rate), nonCompleteRate: Number(row.non_complete_rate), attempts: Number(row.attempts) })),
          dailyKpi: daily.map(row => ({ date: row.date, dau: Number(row.dau), sessions: Number(row.sessions), arpdau: Number(row.arpdau) })),
        };
        await client.query('commit');
        return snapshot;
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    });
  }
}

function validateEvent(event: TelemetryIngestEvent): void {
  if (!isObject(event) || typeof event.eventId !== 'string' || !event.eventId.trim() || event.eventId.length > 160 || event.eventId.includes('\0')
    || typeof event.eventName !== 'string' || event.eventName.length > 160 || !/^[a-z0-9_.:-]+$/i.test(event.eventName)) {
    throw new BadRequestException('Invalid telemetry identity');
  }
  if (!integer(event.schemaVersion, 1, 2_147_483_647) || typeof event.occurredAt !== 'string'
    || event.occurredAt.length > 64 || !Number.isFinite(Date.parse(event.occurredAt))) {
    throw new BadRequestException('Invalid telemetry version or timestamp');
  }
  // This service is the authenticated client ingest boundary, never an authoritative server writer.
  if (event.source !== 'h5' || !isObject(event.payload) || !finiteJson(event.payload)) {
    throw new BadRequestException('Invalid telemetry payload or client source');
  }
  if (Buffer.byteLength(JSON.stringify(event.payload)) > 32_768) throw new BadRequestException('Telemetry payload is too large');
  if (event.eventName === 'game_observation') validateGameplay(event);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function finiteJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return !value.includes('\0');
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => finiteJson(item, depth + 1));
  return isObject(value) && Object.entries(value).every(([key, item]) => !key.includes('\0') && finiteJson(item, depth + 1));
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function uuid(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

type FieldCheck = (value: unknown) => boolean;
const score: FieldCheck = value => integer(value, 0, 1_000_000_000);
const moves: FieldCheck = value => integer(value, 0, 1_000_000);
const boolean: FieldCheck = value => typeof value === 'boolean';
const booster: FieldCheck = value => ['hammer', 'shuffle', 'lightning', 'extraMoves'].includes(value as string);
const gameplayFields: Record<string, Record<string, FieldCheck>> = {
  attempt_selected: {},
  level_started: { movesLeft: moves },
  move_rejected: { reason: value => ['not_adjacent', 'blocked', 'no_match'].includes(value as string) },
  move_resolved: { score, delta: score, cascades: moves, movesLeft: moves },
  booster_used: { booster },
  booster_failed: { booster },
  booster_resolved: { booster, score, delta: score, movesLeft: moves },
  board_shuffled: {},
  level_completed: { score, baseScore: score, bonus: score, won: boolean },
  verification_started: {},
  verification_completed: { score, won: boolean },
  verification_failed: { reason: value => ['rejected', 'unavailable'].includes(value as string) },
  start_failed: {},
};

function exactFields(value: Record<string, unknown>, fields: Record<string, FieldCheck>): boolean {
  return Object.keys(value).length === Object.keys(fields).length
    && Object.entries(fields).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
}

function validateGameplay(event: TelemetryIngestEvent): void {
  const validEnvelope = Object.keys(event).length === 6 && event.schemaVersion === 1 && uuid(event.eventId)
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(event.occurredAt)
    && !event.occurredAt.startsWith('0000')
    && new Date(`${event.occurredAt.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === event.occurredAt.slice(0, 10);
  const validPayload = exactFields(event.payload, {
    sessionId: uuid,
    sequence: value => integer(value, 1),
    elapsedMs: value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER,
    attempt: value => value === null || (isObject(value) && exactFields(value, {
      id: uuid, levelId: value => integer(value, 1, 1_000_000_000), mode: value => value === 'practice' || value === 'ranked',
    })),
    observation: value => {
      if (!isObject(value) || typeof value.type !== 'string' || !Object.hasOwn(gameplayFields, value.type)) return false;
      return exactFields(value, { type: type => type === value.type, ...gameplayFields[value.type] });
    },
  });
  if (!validEnvelope || !validPayload) throw new BadRequestException('Invalid gameplay observation');
}
