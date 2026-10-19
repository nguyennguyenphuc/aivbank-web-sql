import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { InMemoryEconomyRepository } from '../../../server/src/modules/economy/economy.repository.js';
import { EconomyService } from '../../../server/src/modules/economy/economy.service.js';
import { RewardService } from '../../../server/src/modules/economy/reward.service.js';
import { WalletLockService } from '../../../server/src/modules/economy/wallet-lock.service.js';

function setup() {
  const repository = new InMemoryEconomyRepository();
  const economy = new EconomyService(repository, new WalletLockService());
  return { repository, economy };
}

describe('append-only double-entry economy', () => {
  it('returns the original effect for retries and rejects key reuse', async () => {
    const { repository, economy } = setup();
    const first = await economy.postCurrency('p1', 'soft', 1000, 'welcome', 'signup', 'welcome-1');
    const retry = await economy.postCurrency('p1', 'soft', 1000, 'welcome', 'signup', 'welcome-1');
    expect(retry.soft).toBe(first.soft);
    await expect(economy.postCurrency('p1', 'soft', 2000, 'welcome', 'signup', 'welcome-1')).rejects.toThrow(/Idempotency/i);
    const entry = await economy.journalByKey('p1', 'welcome-1');
    expect(entry?.lines.reduce((sum, line) => sum + line.amount, 0)).toBe(0);
    expect(await repository.auditLog('p1')).toHaveLength(1);
  });

  it('serializes concurrent wallet mutations and reverses with a compensating entry', async () => {
    const { repository, economy } = setup();
    await economy.postCurrency('p1', 'soft', 1000, 'seed', 'seed', 'seed-1');
    await Promise.all([
      economy.spend('p1', 'soft', 200, 'shop', 'a', 'spend-a'),
      economy.spend('p1', 'soft', 300, 'shop', 'b', 'spend-b'),
    ]);
    expect((await economy.wallet('p1')).soft).toBe(500);
    const original = await economy.journalByKey('p1', 'spend-a');
    const restored = await economy.reverse('p1', original!.journalId, 'reverse-a');
    expect(restored.soft).toBe(700);
    expect((await economy.journalByKey('p1', 'reverse-a'))?.reversalOf).toBe(original?.journalId);
  });

  it('scopes client idempotency keys per account', async () => {
    const { economy } = setup();
    await economy.postCurrency('p1', 'soft', 100, 'gift', 'day-1', 'shared-client-key');
    await economy.postCurrency('p2', 'soft', 200, 'gift', 'day-1', 'shared-client-key');
    expect((await economy.wallet('p1')).soft).toBe(100);
    expect((await economy.wallet('p2')).soft).toBe(200);
  });

  it('makes deterministic daily spin claims one-time even under a new retry key', async () => {
    const { economy } = setup();
    const rewards = new RewardService(economy);
    const first = await rewards.dailySpin('p1', '2026-08-28', 'spin-attempt-1');
    await expect(rewards.dailySpin('p1', '2026-08-28', 'spin-attempt-2')).rejects.toThrow(/claimed/i);
    expect(first.reward).toHaveLength(1);
  });

  it('settles simultaneous daily gifts once and recovers the current wallet after a lost response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    try {
      const { repository, economy } = setup();
      const rewards = new RewardService(economy);
      expect((await rewards.dailyGiftStatus('p1')).claimed).toBe(false);
      const results = await Promise.all([
        rewards.dailyGift('p1', '2026-09-10', 'gift-original'),
        rewards.dailyGift('p1', '2026-09-10', 'gift-original'),
        rewards.dailyGift('p1', '2026-09-10', 'gift-other-tab'),
      ]);
      for (const result of results) {
        expect(result.wallet.soft).toBe(150);
        expect(result.dailyGift.claimed).toBe(true);
      }
      await economy.spend('p1', 'soft', 50, 'shop', 'booster', 'spend-after-gift');
      const retry = await rewards.dailyGift('p1', '2026-09-10', 'gift-original');
      expect(retry.wallet.soft).toBe(100);
      expect(retry.dailyGift.claimed).toBe(true);
      expect((await repository.auditLog('p1')).filter(entry => entry.action === 'daily-gift')).toHaveLength(1);
      expect((await rewards.dailyGiftStatus('p1')).claimed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invented gift days and opens eligibility only when the server UTC day advances', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T23:59:59Z'));
    try {
      const { economy } = setup();
      const rewards = new RewardService(economy);
      await rewards.dailyGift('p1', '2026-09-10', 'gift-today');
      await expect(rewards.dailyGift('p1', '2026-09-11', 'gift-future')).rejects.toBeInstanceOf(BadRequestException);
      await expect(rewards.dailyGift('p1', '2026-09-09', 'gift-past')).rejects.toBeInstanceOf(BadRequestException);
      expect((await economy.wallet('p1')).soft).toBe(150);
      vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
      expect((await rewards.dailyGiftStatus('p1')).claimed).toBe(false);
      const nextDay = await rewards.dailyGift('p1', '2026-09-11', 'gift-next-day');
      expect(nextDay.wallet.soft).toBe(300);
      expect(nextDay.dailyGift.claimed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hydrates an already-claimed starter pack without regranting or requiring its original request key', async () => {
    const { repository, economy } = setup();
    const rewards = new RewardService(economy);
    await economy.grant('p1', [{ currency: 'soft', amount: 250 }, { itemId: 'hammer', quantity: 3 }], 'starter-pack', 'starter.v1', 'historical-bootstrap', 'starter-pack:p1');
    await economy.spend('p1', 'soft', 50, 'shop', 'purchase', 'after-starter');
    const wallet = await rewards.starterPack('p1');
    expect(wallet.soft).toBe(200);
    expect(wallet.inventory.hammer).toBe(3);
    expect((await repository.auditLog('p1')).filter(entry => entry.action === 'starter-pack')).toHaveLength(1);
  });

  it('authorizes practice extra moves with an idempotent backend currency spend', async () => {
    const { economy } = setup();
    const rewards = new RewardService(economy);
    await economy.postCurrency('p1', 'soft', 100, 'seed', 'seed', 'seed-extra-moves');

    const first = await rewards.buyExtraMoves('p1', 'practice-attempt-1', 'extra-moves-1');
    const retry = await rewards.buyExtraMoves('p1', 'practice-attempt-1', 'extra-moves-1');

    expect(first.soft).toBe(20);
    expect(retry.soft).toBe(20);
  });

  it('consumes boosters idempotently through the allowlisted command and rejects unsupported items', async () => {
    const { economy } = setup();
    await economy.grant('p1', [{ itemId: 'hammer', quantity: 1 }], 'seed', 'seed', 'seed-1');

    const first = await economy.useBooster('p1', 'hammer', 'practice:level-1:hammer:0:0', 'booster-use-1');
    const retry = await economy.useBooster('p1', 'hammer', 'practice:level-1:hammer:0:0', 'booster-use-1');

    expect(first.inventory.hammer).toBe(0);
    expect(retry.inventory.hammer).toBe(0);
    await expect(economy.useBooster('p1', 'hammer', 'practice:level-1:hammer:0:1', 'booster-use-2')).rejects.toThrow(/Insufficient inventory/i);
    await expect(economy.useBooster('p1', 'bogus' as never, 'practice:level-1:bogus:0:2', 'booster-use-3')).rejects.toThrow(/Unsupported booster type/i);
    await expect(economy.useBooster('p1', 'hammer', '', 'booster-use-4')).rejects.toThrow(/referenceId/i);
    await expect(economy.useBooster('p1', 'hammer', 'x'.repeat(161), 'booster-use-5')).rejects.toThrow(/referenceId/i);
  });

  it('does not reserve an idempotency key when booster inventory validation fails', async () => {
    const { economy } = setup();
    const key = 'booster-use-after-refill';
    const referenceId = 'practice:session:level-1:hammer:0:0';

    await expect(economy.useBooster('p1', 'hammer', referenceId, key)).rejects.toThrow(/Insufficient inventory/i);
    expect(await economy.journalByKey('p1', key)).toBeUndefined();

    await economy.grant('p1', [{ itemId: 'hammer', quantity: 1 }], 'seed', 'seed', 'seed-after-failure');
    const wallet = await economy.useBooster('p1', 'hammer', referenceId, key);
    expect(wallet.inventory.hammer).toBe(0);
  });
});
