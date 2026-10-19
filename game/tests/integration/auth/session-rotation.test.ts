import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../server/src/config/env.js';
import { InMemoryAuthRepository } from '../../../server/src/modules/auth/auth.repository.js';
import { AuthService } from '../../../server/src/modules/auth/auth.service.js';
import { SessionSigner } from '../../../server/src/modules/auth/session-signer.js';
import { InMemoryPlayerRepository } from '../../../server/src/modules/player/player.repository.js';
import { PlayerService } from '../../../server/src/modules/player/player.service.js';

const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'integration-session-secret',
});

describe('guest sessions and cross-device restore', () => {
  it('rotates refresh tokens and rejects replay of the old token', async () => {
    const repository = new InMemoryAuthRepository();
    const auth = new AuthService(repository, new SessionSigner(env));
    const first = await auth.createGuest('device-a');
    const rotated = await auth.rotate(first.refreshToken);

    expect(rotated.principal.accountId).toBe(first.principal.accountId);
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    await expect(auth.rotate(first.refreshToken)).rejects.toThrow(/replay/i);
    await expect(auth.authenticate(rotated.accessToken)).rejects.toThrow(/not active/i);
  });

  it('upgrades a guest and restores one authoritative snapshot on another device', async () => {
    const auth = new AuthService(new InMemoryAuthRepository(), new SessionSigner(env));
    const players = new PlayerService(new InMemoryPlayerRepository());
    const guest = await auth.createGuest('phone');
    await auth.upgrade(guest.principal.accountId, 'player@example.com', 'correct horse battery');
    const progress = await players.commitProgress(guest.principal.accountId, {
      unlockedLevel: 8,
      starsEarned: 17,
      totalScore: 32000,
      lastLevelId: 7,
      expectedRevision: 0,
    });
    const desktop = await auth.login('player@example.com', 'correct horse battery', 'desktop');
    const restored = await players.restore(desktop.principal.accountId);

    expect(desktop.principal.accountId).toBe(guest.principal.accountId);
    expect(restored.progress).toEqual(progress.progress);
  });

  it('deduplicates offline unranked practice operations without granting authority', async () => {
    const players = new PlayerService(new InMemoryPlayerRepository());
    const result = { operationId: 'offline-1', levelId: 3, score: 1200, stars: 2, ranked: false as const };
    expect(await players.syncPractice('account-1', [result])).toEqual({ accepted: ['offline-1'], duplicates: [] });
    expect(await players.syncPractice('account-1', [result])).toEqual({ accepted: [], duplicates: ['offline-1'] });
    expect((await players.restore('account-1')).progress.totalScore).toBe(0);
  });
});
