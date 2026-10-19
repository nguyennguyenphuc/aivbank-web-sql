import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TelemetryIngestEvent } from '../../shared/contracts/telemetry/index.js';
import { AnalyticsService } from '../../server/src/modules/analytics/analytics.service.js';
import {
  countryFromAcceptLanguage, deviceTierFromUserAgent, LiveProjectionService, localDateTime, platformFromUserAgent,
} from '../../server/src/modules/live-projection/live-projection.service.js';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36';

function observation(type: string, fields: Record<string, unknown> = {}, attemptId = randomUUID()): TelemetryIngestEvent {
  return {
    eventId: randomUUID(), eventName: 'game_observation', schemaVersion: 1,
    occurredAt: '2026-09-28T07:00:00.000Z', source: 'h5',
    payload: {
      sessionId: randomUUID(), sequence: 1, elapsedMs: 90_000,
      attempt: { id: attemptId, levelId: 28, mode: 'practice' }, observation: { type, ...fields },
    },
  };
}

function fixture(identity: boolean = true) {
  const statements: { text: string; params: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (text: string, params: unknown[] = []) => {
      statements.push({ text, params });
      if (text.includes('from account_identities')) {
        return { rows: identity ? [{ user_id: 'aivb_sv001', install_date: '2026-09-23' }] : [] };
      }
      if (text.includes('insert into jelly_analytics.users')) return { rows: [{ user_id: 'aivb_sv001', platform: params[2], country: params[3] }] };
      return { rows: [] };
    }),
  };
  const database = { withClient: vi.fn(async (fn: (c: typeof client) => Promise<unknown>) => fn(client)) };
  const service = new LiveProjectionService(database as never, { NODE_ENV: 'production' } as never);
  return { service, statements, database };
}

describe('live projection helpers', () => {
  it('derives platform and device tier from the browser user agent', () => {
    expect(platformFromUserAgent(ANDROID)).toBe('Android');
    expect(platformFromUserAgent(IPHONE)).toBe('iOS');
    expect(platformFromUserAgent(DESKTOP)).toBe('Web');
    expect(platformFromUserAgent(undefined)).toBe('Web');
    expect(deviceTierFromUserAgent(ANDROID)).toBe('mobile');
    expect(deviceTierFromUserAgent(DESKTOP)).toBe('desktop');
  });

  it('derives country from the first regional Accept-Language tag, defaulting to VN', () => {
    expect(countryFromAcceptLanguage('vi-VN,vi;q=0.9,en-US;q=0.8')).toBe('VN');
    expect(countryFromAcceptLanguage('en-US,en;q=0.9')).toBe('US');
    expect(countryFromAcceptLanguage('vi')).toBe('VN');
    expect(countryFromAcceptLanguage('en')).toBe('VN');
    expect(countryFromAcceptLanguage(undefined)).toBe('VN');
  });

  it('formats instants in Vietnam local time like the synthetic tables', () => {
    expect(localDateTime('2026-09-28T17:30:05Z')).toEqual({ date: '2026-09-29', time: '2026-09-29T00:30:05' });
  });
});

describe('live projection writes', () => {
  it('projects a level start as an aivb_ user, session and in-progress attempt in one transaction', async () => {
    const { service, statements } = fixture();
    const attemptId = randomUUID();
    await service.observation('account-1', observation('level_started', { movesLeft: 30 }, attemptId), { userAgent: ANDROID, acceptLanguage: 'vi-VN' });
    const texts = statements.map(s => s.text);
    expect(texts[0]).toBe('begin');
    expect(texts.at(-1)).toBe('commit');
    const user = statements.find(s => s.text.includes('insert into jelly_analytics.users'))!;
    expect(user.params.slice(0, 7)).toEqual(['aivb_sv001', '2026-09-23', 'Android', 'VN', 'AIV Bank', 'web-live', 'mobile']);
    const attempt = statements.find(s => s.text.includes('insert into jelly_analytics.level_attempts'))!;
    expect(attempt.params[0]).toBe(`aivb_a_${attemptId}`);
    expect(attempt.params[7]).toBe('30');
    expect(attempt.params[8]).toBe('web-live');
    expect(texts.some(t => t.includes("set result = 'quit'"))).toBe(true);
    expect(texts.some(t => t.includes('insert into jelly_analytics.player_daily'))).toBe(true);
  });

  it('marks a completed attempt and skips daily rollups for per-move observations', async () => {
    const { service, statements } = fixture();
    await service.observation('account-1', observation('move_resolved', { score: 10, delta: 10, cascades: 0, movesLeft: 12 }));
    expect(statements.some(s => s.text.includes('set moves_left'))).toBe(true);
    expect(statements.some(s => s.text.includes('player_daily'))).toBe(false);
    statements.length = 0;
    await service.observation('account-1', observation('level_completed', { score: 1, baseScore: 1, bonus: 0, won: true }));
    expect(statements.find(s => s.text.includes('set result = $2'))!.params[1]).toBe('complete');
  });

  it('skips accounts without an AIV Bank identity', async () => {
    const { service, statements } = fixture(false);
    await service.observation('guest', observation('level_started', { movesLeft: 30 }));
    expect(statements.some(s => s.text.includes('insert into'))).toBe(false);
    expect(statements.at(-1)!.text).toBe('commit');
  });

  it('never fails the caller when projection breaks', async () => {
    const database = { withClient: vi.fn(async () => { throw new Error('db down'); }) };
    const service = new LiveProjectionService(database as never, { NODE_ENV: 'production' } as never);
    await expect(service.observation('a', observation('level_started', { movesLeft: 1 }))).resolves.toBeUndefined();
  });

  it('is disabled in test/fake mode', async () => {
    const database = { withClient: vi.fn() };
    const service = new LiveProjectionService(database as never, { NODE_ENV: 'test' } as never);
    await service.observation('a', observation('level_started', { movesLeft: 1 }));
    expect(database.withClient).not.toHaveBeenCalled();
  });

  it('is only invoked for first deliveries, not duplicates', async () => {
    const projection = { observation: vi.fn(async () => undefined) };
    const inserted = { query: vi.fn(async () => [{ event_id: 'x' }]) };
    const env = { NODE_ENV: 'test', TELEMETRY_HASH_SECRET: 's' };
    const event = observation('level_started', { movesLeft: 30 });
    await new AnalyticsService(inserted as never, env as never, projection as never).ingest('acc', event, { userAgent: DESKTOP });
    expect(projection.observation).toHaveBeenCalledWith('acc', event, { userAgent: DESKTOP });
    projection.observation.mockClear();
    const hash = createHmac('sha256', 's').update('acc').digest('hex');
    const duplicate = { query: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ player_hash: hash, same_content: true }]) };
    const service = new AnalyticsService(duplicate as never, env as never, projection as never);
    await expect(service.ingest('acc', event)).resolves.toEqual({ accepted: true, duplicate: true });
    expect(projection.observation).not.toHaveBeenCalled();
  });
});
