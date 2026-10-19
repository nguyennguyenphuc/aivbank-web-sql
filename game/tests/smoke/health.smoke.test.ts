import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../../server/src/create-app.js';
import { loadEnv } from '../../server/src/config/env.js';

describe('smoke api', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.USE_FAKE_INTEGRATIONS = '1';
    process.env.LOG_LEVEL = 'silent';

    app = await createApp(loadEnv());
  });

  afterAll(async () => {
    await app?.close();
  });

  it('exposes health and readiness endpoints with request ids', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['x-request-id']).toBeTruthy();
    expect(health.json()).toEqual({ ok: true });

    const ready = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.headers['x-request-id']).toBeTruthy();
    expect(ready.json()).toMatchObject({
      ok: true,
      dependencies: {
        postgres: { ok: true, mode: 'fake' },
        redis: { ok: true, mode: 'fake' },
      },
    });
  });

  it('returns a wrapped error envelope for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.json()).toMatchObject({
      error: {
        requestId: expect.any(String),
      },
    });
  });

  it('enforces origin and CSRF validation on ranked run mutations', async () => {
    const guest = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/guest',
      payload: { deviceId: 'csrf-smoke-device' },
    });
    expect(guest.statusCode).toBe(201);
    const setCookies = Array.isArray(guest.headers['set-cookie'])
      ? guest.headers['set-cookie']
      : [guest.headers['set-cookie'] ?? ''];
    const cookie = setCookies.map(value => value.split(';')[0]).join('; ');
    const csrf = setCookies
      .map(value => value.match(/^csrf=([^;]+)/)?.[1])
      .find(Boolean);
    expect(csrf).toBeTruthy();

    const denied = await app.inject({
      method: 'POST',
      url: '/api/gameplay/runs/start',
      headers: { cookie },
      payload: { levelId: 1, contentRevision: 'content.v2.1.1', appVersion: '2.1.1' },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/gameplay/runs/start',
      headers: { cookie, origin: 'http://localhost:3000', 'x-csrf-token': csrf! },
      payload: { levelId: 1, contentRevision: 'content.v2.1.1', appVersion: '2.1.1' },
    });
    expect(allowed.statusCode).toBe(201);
    expect(allowed.json()).toMatchObject({ levelId: 1, contentRevision: 'content.v2.1.1' });
  });

  it('rejects unsafe or incomplete environment configuration', () => {
    expect(() => loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'not-a-url',
      REDIS_URL: 'redis://localhost:6379',
    })).toThrow(/Invalid environment/);

    expect(() => loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://match3:secret@postgres:5432/match3_h5',
      REDIS_URL: 'redis://app:secret@redis:6379',
      WEB_ORIGIN: 'https://candy.longh.work',
      SESSION_SECRET: 'same-production-secret-value-32-bytes',
      TELEMETRY_HASH_SECRET: 'same-production-secret-value-32-bytes',
    })).toThrow(/independent from SESSION_SECRET/);

    expect(() => loadEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://match3:secret@postgres:5432/match3_h5',
      REDIS_URL: 'redis://app:secret@redis:6379',
      WEB_ORIGIN: 'http://candy.longh.work',
      SESSION_SECRET: 'production-session-secret-value-over-32-bytes',
      TELEMETRY_HASH_SECRET: 'production-telemetry-secret-value-over-32-bytes',
    })).toThrow(/must use https in production/);
  });
});
