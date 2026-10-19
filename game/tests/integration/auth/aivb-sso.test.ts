import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../server/src/config/env.js';
import { isAllowedOrigin } from '../../../server/src/common/auth/origin-csrf.guard.js';
import { InMemoryAuthRepository } from '../../../server/src/modules/auth/auth.repository.js';
import { AuthService } from '../../../server/src/modules/auth/auth.service.js';
import { SessionSigner } from '../../../server/src/modules/auth/session-signer.js';
import { signAivbTicket, verifyAivbTicket, type AivbTicketClaims } from '../../../server/src/modules/auth/aivb-sso.js';

const SECRET = 'aivb-sso-test-secret-that-is-32-bytes-long';
const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'integration-session-secret',
  AIVB_SSO_SECRET: SECRET,
  WEB_ORIGIN: 'https://aivbank.example.org, http://127.0.0.1:8000',
  PUBLIC_BASE_PATH: '/game',
});

function claims(overrides: Partial<AivbTicketClaims> = {}): AivbTicketClaims {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'aivb', sub: 'sv001', name: 'Nguyễn Văn A', role: 'student', iat: now, exp: now + 60, jti: crypto.randomUUID(), ...overrides };
}

describe('AIV Bank SSO ticket', () => {
  it('accepts a fresh ticket signed with the shared secret', () => {
    expect(verifyAivbTicket(signAivbTicket(claims(), SECRET), SECRET).sub).toBe('sv001');
  });

  it('rejects a bad signature, an expired ticket and an over-long lifetime', () => {
    expect(() => verifyAivbTicket(signAivbTicket(claims(), 'another-secret-another-secret-123'), SECRET)).toThrow(/Invalid SSO ticket/);
    const past = Math.floor(Date.now() / 1000) - 120;
    expect(() => verifyAivbTicket(signAivbTicket(claims({ iat: past, exp: past + 60 }), SECRET), SECRET)).toThrow(/expired/);
    const now = Math.floor(Date.now() / 1000);
    expect(() => verifyAivbTicket(signAivbTicket(claims({ exp: now + 3600 }), SECRET), SECRET)).toThrow(/expired/);
    expect(() => verifyAivbTicket(signAivbTicket(claims({ sub: "x'; drop" }), SECRET), SECRET)).toThrow();
  });

  it('creates one account per AIV Bank user and refuses a replayed ticket', async () => {
    const auth = new AuthService(new InMemoryAuthRepository(), new SessionSigner(env), env);
    const ticket = signAivbTicket(claims(), SECRET);
    const first = await auth.aivbSso(ticket, 'device-a');
    expect(first.principal.guest).toBe(false);
    expect(first.principal.roles).toEqual(['student']);
    await expect(auth.aivbSso(ticket, 'device-a')).rejects.toThrow(/already used/);

    const again = await auth.aivbSso(signAivbTicket(claims({ role: 'instructor' }), SECRET), 'device-b');
    expect(again.principal.accountId).toBe(first.principal.accountId);
    expect(again.principal.roles).toEqual(['instructor']);

    const other = await auth.aivbSso(signAivbTicket(claims({ sub: 'sv002' }), SECRET), 'device-a');
    expect(other.principal.accountId).not.toBe(first.principal.accountId);
  });

  it('is disabled when no shared secret is configured', async () => {
    const plain = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://t:t@localhost/t', REDIS_URL: 'redis://localhost:6379', SESSION_SECRET: 'integration-session-secret' });
    const auth = new AuthService(new InMemoryAuthRepository(), new SessionSigner(plain), plain);
    await expect(auth.aivbSso(signAivbTicket(claims(), SECRET), 'd')).rejects.toThrow(/not enabled/);
  });

  it('accepts every configured origin and nothing else', () => {
    expect(isAllowedOrigin(env, 'https://aivbank.example.org')).toBe(true);
    expect(isAllowedOrigin(env, 'http://127.0.0.1:8000')).toBe(true);
    expect(isAllowedOrigin(env, 'https://evil.example.org')).toBe(false);
    expect(isAllowedOrigin(env, undefined)).toBe(false);
  });
});
