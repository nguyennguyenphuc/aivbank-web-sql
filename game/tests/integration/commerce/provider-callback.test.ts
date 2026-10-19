import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../server/src/config/env.js';
import { InMemoryCommerceRepository } from '../../../server/src/modules/commerce/commerce.repository.js';
import { CommerceService } from '../../../server/src/modules/commerce/commerce.service.js';
import { SandboxPaymentProvider } from '../../../server/src/modules/commerce/payment-provider.js';
import { InMemoryEconomyRepository } from '../../../server/src/modules/economy/economy.repository.js';
import { EconomyService } from '../../../server/src/modules/economy/economy.service.js';
import { WalletLockService } from '../../../server/src/modules/economy/wallet-lock.service.js';

const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'integration-session-secret',
});

describe('sandbox payment callbacks', () => {
  it('verifies callbacks and makes duplicate delivery replay-safe', async () => {
    const economy = new EconomyService(new InMemoryEconomyRepository(), new WalletLockService());
    const provider = new SandboxPaymentProvider(env);
    const commerce = new CommerceService(new InMemoryCommerceRepository(), provider, economy);
    const intent = await commerce.createPaymentIntent('p1', 'coins-1000');
    const unsigned = { intentId: intent.intentId, providerEventId: 'payment-event-1', status: 'paid' as const };
    const callback = { ...unsigned, signature: provider.signCallback(unsigned) };
    const [first, duplicate] = await Promise.all([commerce.settleCallback(callback), commerce.settleCallback(callback)]);

    expect(first.receiptId).toBe(duplicate.receiptId);
    expect((await economy.wallet('p1')).soft).toBe(1000);
    await expect(commerce.settleCallback({ ...callback, providerEventId: 'tampered' })).rejects.toThrow(/signature/i);
  });

  it('refunds through a compensating journal without deleting the receipt', async () => {
    const economy = new EconomyService(new InMemoryEconomyRepository(), new WalletLockService());
    const provider = new SandboxPaymentProvider(env);
    const commerce = new CommerceService(new InMemoryCommerceRepository(), provider, economy);
    const intent = await commerce.createPaymentIntent('p1', 'gems-50');
    const unsigned = { intentId: intent.intentId, providerEventId: 'payment-event-2', status: 'paid' as const };
    await commerce.settleCallback({ ...unsigned, signature: provider.signCallback(unsigned) });
    const refund = await commerce.refund(intent.intentId, 'refund-1');
    expect(refund.status).toBe('refunded');
    expect(refund.wallet.hard).toBe(0);
  });
});
