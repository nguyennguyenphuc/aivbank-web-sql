import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../../server/src/config/env.js';
import { DatabaseService } from '../../../server/src/database/database.service.js';
import { PostgresAuthRepository } from '../../../server/src/modules/auth/postgres-auth.repository.js';
import { PostgresEconomyRepository } from '../../../server/src/modules/economy/postgres-economy.repository.js';
import { EconomyService } from '../../../server/src/modules/economy/economy.service.js';
import { WalletLockService } from '../../../server/src/modules/economy/wallet-lock.service.js';
import { RewardService } from '../../../server/src/modules/economy/reward.service.js';

const enabled = process.env.REAL_POSTGRES_TEST === '1';
const suite = describe.skipIf(!enabled);

suite('PostgreSQL economy persistence', () => {
  const accountId = randomUUID();
  const env = loadEnv({
    NODE_ENV: 'development',
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/match3_h5',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'integration-session-secret',
    LOG_LEVEL: 'silent',
  });
  const database = new DatabaseService(env);
  const auth = new PostgresAuthRepository(database);
  const repository = new PostgresEconomyRepository(database);
  const economy = new EconomyService(repository, new WalletLockService());

  beforeAll(async () => {
    await database.onModuleInit();
    await auth.createAccount({ accountId, displayName: 'Postgres Test', guest: true, roles: ['student'], createdAt: new Date().toISOString() });
  });

  afterAll(async () => {
    await database.query('delete from accounts where account_id = $1', [accountId]);
    await database.onModuleDestroy();
  });

  it('locks, persists, deduplicates, and balances journal lines', async () => {
    await Promise.all([
      economy.postCurrency(accountId, 'soft', 100, 'postgres-test', 'a', `pg-a-${accountId}`),
      economy.postCurrency(accountId, 'soft', 200, 'postgres-test', 'b', `pg-b-${accountId}`),
    ]);
    await economy.postCurrency(accountId, 'soft', 100, 'postgres-test', 'a', `pg-a-${accountId}`);
    expect((await economy.wallet(accountId)).soft).toBe(300);
    const journal = await economy.journalByKey(accountId, `pg-a-${accountId}`);
    expect(journal?.lines.reduce((sum, line) => sum + line.amount, 0)).toBe(0);
    expect(await repository.auditLog(accountId)).toHaveLength(2);
  });

  it('grants a daily gift once across independent API wallet locks', async () => {
    const firstProcess = new RewardService(economy);
    const secondProcess = new RewardService(new EconomyService(repository, new WalletLockService()));
    const { day } = await firstProcess.dailyGiftStatus(accountId);
    const before = await economy.wallet(accountId);
    const results = await Promise.all([
      firstProcess.dailyGift(accountId, day, `gift-first-${accountId}`),
      secondProcess.dailyGift(accountId, day, `gift-second-${accountId}`),
    ]);
    for (const result of results) expect(result.dailyGift.claimed).toBe(true);
    expect((await economy.wallet(accountId)).soft).toBe(before.soft + 150);
    const retry = await secondProcess.dailyGift(accountId, day, `gift-second-${accountId}`);
    expect(retry.wallet.soft).toBe(before.soft + 150);
    expect((await repository.auditLog(accountId)).filter(entry => entry.action === 'daily-gift')).toHaveLength(1);
  });
});
