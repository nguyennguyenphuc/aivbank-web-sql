import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TelemetryIngestEvent } from '../../shared/contracts/telemetry/index.js';
import { loadEnv } from '../../server/src/config/env.js';
import { DatabaseService } from '../../server/src/database/database.service.js';
import { AnalyticsController } from '../../server/src/modules/analytics/analytics.controller.js';
import { AnalyticsService } from '../../server/src/modules/analytics/analytics.service.js';

const testEnv = { NODE_ENV: 'test', TELEMETRY_HASH_SECRET: 'test-hash-secret', SESSION_SECRET: 'session-secret' };
function gameplay(observation: Record<string, unknown> = { type: 'attempt_selected' }): TelemetryIngestEvent {
  return {
    eventId: randomUUID(), eventName: 'game_observation', schemaVersion: 1,
    occurredAt: '2026-08-28T00:00:00.123Z', source: 'h5',
    payload: {
      sessionId: randomUUID(), sequence: 1, elapsedMs: 1.25,
      attempt: { id: randomUUID(), levelId: 28, mode: 'practice' }, observation,
    },
  };
}

function fixture() {
  const query = vi.fn(async () => [{ event_id: 'inserted' }]);
  return { query, service: new AnalyticsService({ query } as never, testEnv as never) };
}

describe('client telemetry boundary', () => {
  it('rejects server and import source even for established non-game events', async () => {
    const { service, query } = fixture();
    for (const source of ['server', 'import'] as const) {
      await expect(service.ingest('account', { ...gameplay(), eventName: 'level.start', source })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('requires account binding before a gameplay row can be attributed to the session', async () => {
    const { service, query } = fixture();
    const controller = new AnalyticsController(service);
    for (const headers of [{}, { 'x-telemetry-account-id': 'old-account' }]) {
      expect(() => controller.ingest({ auth: { accountId: 'current-account' }, headers } as never, gameplay())).toThrow(ConflictException);
    }
    expect(query).not.toHaveBeenCalled();
    await expect(controller.ingest({ auth: { accountId: 'current-account' }, headers: { 'x-telemetry-account-id': 'current-account' } } as never, gameplay()))
      .resolves.toEqual({ accepted: true, duplicate: false });
  });

  it('rejects malformed envelopes and non-finite or non-object JSON without writing', async () => {
    const { service, query } = fixture();
    const event = gameplay();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalid: unknown[] = [null, [], 12, { ...event, eventId: 1 }, { ...event, occurredAt: 123 },
      { ...event, schemaVersion: 2_147_483_648 }, { ...event, payload: 'secret' }, { ...event, payload: [] },
      { ...event, payload: { bad: Infinity } }, { ...event, payload: { bad: NaN } },
      { ...event, payload: { bad: BigInt(1) } }, { ...event, payload: cyclic },
      { ...event, eventName: 'level.start', payload: { nested: { bad: undefined } } },
      { ...event, eventName: 'level.start', payload: { secret: 'a'.repeat(32_769) } }];
    for (const input of invalid) await expect(service.ingest('account', input as TelemetryIngestEvent)).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects unknown gameplay fields, arbitrary strings, spoofed authority, and invalid bounds', async () => {
    const { service, query } = fixture();
    const event = gameplay();
    const observations = [
      { type: 'screen_viewed', screen: 'login' }, { type: 'dialog_opened', dialog: 'shop' },
      { type: 'attempt_selected', password: 'secret' }, { type: 'verification_completed', score: 10, won: true, source: 'server' },
      { type: 'booster_used', booster: 'classroom answer' }, { type: 'move_rejected', reason: 'arbitrary error body' },
      { type: 'verification_failed', reason: 'token expired: secret' }, { type: 'level_started', movesLeft: -1 },
      { type: 'move_resolved', score: 10, delta: 10, cascades: 0.5, movesLeft: 4 },
      { type: 'verification_completed', score: 1_000_000_001, won: true },
      { type: 'level_completed', score: 10, baseScore: 10, bonus: 0, won: 'true' },
      { type: 'toString' }, { type: 'booster_resolved', booster: 'hammer', score: 10, delta: 10 },
    ];
    const invalid = [
      ...observations.map(observation => ({ ...event, payload: { ...event.payload, observation } })),
      { ...event, schemaVersion: 2 }, { ...event, occurredAt: '2026-08-28' },
      { ...event, occurredAt: '2026-02-30T00:00:00Z' },
      { ...event, payload: { ...event.payload, sessionId: 'account@email.test' } },
      { ...event, payload: { ...event.payload, sequence: 0 } },
      { ...event, payload: { ...event.payload, elapsedMs: -1 } },
      { ...event, payload: { ...event.payload, token: 'secret' } },
      { ...event, payload: { ...event.payload, attempt: { id: randomUUID(), levelId: 28, mode: 'practice', accountId: 'secret' } } },
      { ...event, payload: { ...event.payload, attempt: { id: randomUUID(), levelId: 0, mode: 'practice' } } },
      { ...event, accountId: 'secret' },
    ];
    for (const input of invalid) await expect(service.ingest('account', input)).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts actual practice and ranked event variants, including client-reported server responses', async () => {
    const { service } = fixture();
    const observations = [
      { type: 'attempt_selected' }, { type: 'level_started', movesLeft: 30 },
      { type: 'move_rejected', reason: 'no_match' }, { type: 'move_resolved', score: 100, delta: 100, cascades: 1, movesLeft: 29 },
      ...['hammer', 'shuffle', 'lightning', 'extraMoves'].flatMap(booster => [
        { type: 'booster_used', booster }, { type: 'booster_failed', booster },
        { type: 'booster_resolved', booster, score: 100, delta: 0, movesLeft: 34 },
      ]),
      { type: 'board_shuffled' }, { type: 'level_completed', score: 200, baseScore: 100, bonus: 100, won: true },
      { type: 'verification_started' }, { type: 'verification_completed', score: 200, won: false },
      { type: 'verification_failed', reason: 'rejected' }, { type: 'verification_failed', reason: 'unavailable' }, { type: 'start_failed' },
    ];
    for (const observation of observations) {
      await expect(service.ingest('account', gameplay(observation))).resolves.toEqual({ accepted: true, duplicate: false });
    }
  });
});

describe.skipIf(process.env.REAL_POSTGRES_TEST !== '1')('PostgreSQL immutable telemetry', () => {
  const database = new DatabaseService(loadEnv({
    NODE_ENV: 'development', DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/match3_h5',
    REDIS_URL: 'redis://localhost:6379', SESSION_SECRET: 'integration-session-secret', LOG_LEVEL: 'silent',
  }));
  const service = new AnalyticsService(database, testEnv as never);
  const account = randomUUID();
  const eventIds: string[] = [];
  function legacyEvent(): TelemetryIngestEvent {
    const eventId = randomUUID();
    eventIds.push(eventId);
    return { eventId, eventName: 'level.start', schemaVersion: 1, occurredAt: '2026-08-28T00:00:00.123456Z', source: 'h5', payload: { levelId: 28, nested: { one: 1, two: 2 }, list: [1, 2] } };
  }
  beforeAll(() => database.onModuleInit());
  afterAll(async () => {
    await database.query('delete from analytics_event_spine where event_id = any($1::text[])', [eventIds]);
    await database.onModuleDestroy();
  });

  it('atomically acknowledges simultaneous retries once and compares nested JSON independent of key order', async () => {
    const event = legacyEvent();
    const results = await Promise.all(Array.from({ length: 8 }, () => service.ingest(account, event)));
    expect(results.filter(result => !result.duplicate)).toEqual([{ accepted: true, duplicate: false }]);
    expect(results.filter(result => result.duplicate)).toHaveLength(7);
    await expect(service.ingest(account, { ...event, occurredAt: '2026-08-28T01:00:00.123456+01:00', payload: { list: [1, 2], nested: { two: 2, one: 1 }, levelId: 28 } }))
      .resolves.toEqual({ accepted: true, duplicate: true });
    const rows = await database.query('select player_hash from analytics_event_spine where event_id = $1', [event.eventId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].player_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0].player_hash).not.toBe(account);
  });

  it('rejects another account reusing the same event id and payload', async () => {
    const event = legacyEvent();
    await service.ingest(account, event);
    await expect(service.ingest(randomUUID(), event)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.ingest(account, event)).resolves.toEqual({ accepted: true, duplicate: true });
  });

  it('rejects changes to every immutable envelope field and preserves array order and submillisecond timestamps', async () => {
    const event = legacyEvent();
    await service.ingest(account, event);
    const changes: Partial<TelemetryIngestEvent>[] = [
      { eventName: 'level.end' }, { schemaVersion: 2 }, { occurredAt: '2026-08-28T00:00:00.123457Z' },
      { payload: { ...event.payload, levelId: 29 } }, { payload: { ...event.payload, list: [2, 1] } },
    ];
    for (const change of changes) await expect(service.ingest(account, { ...event, ...change })).rejects.toBeInstanceOf(ConflictException);
    const [stored] = await database.query('select * from analytics_event_spine where event_id = $1', [event.eventId]);
    const serverEvent = legacyEvent();
    await database.query(`insert into analytics_event_spine (event_id, player_hash, event_name, schema_version, occurred_at, payload, source)
      values ($1, $2, $3, $4, $5, $6::jsonb, 'server')`,
    [serverEvent.eventId, stored.player_hash, serverEvent.eventName, serverEvent.schemaVersion, serverEvent.occurredAt, JSON.stringify(serverEvent.payload)]);
    await expect(service.ingest(account, serverEvent)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.ingest(account, event)).resolves.toEqual({ accepted: true, duplicate: true });
  });
});
