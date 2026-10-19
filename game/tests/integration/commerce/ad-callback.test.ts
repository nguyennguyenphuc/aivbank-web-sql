import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../server/src/config/env.js';
import { SandboxAdProvider } from '../../../server/src/modules/ads/ad-provider.js';
import { InMemoryAdsRepository } from '../../../server/src/modules/ads/ads.repository.js';
import { AdsService } from '../../../server/src/modules/ads/ads.service.js';
import { InMemoryEconomyRepository } from '../../../server/src/modules/economy/economy.repository.js';
import { EconomyService } from '../../../server/src/modules/economy/economy.service.js';
import { WalletLockService } from '../../../server/src/modules/economy/wallet-lock.service.js';

const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://test:test@localhost/test', REDIS_URL: 'redis://localhost:6379', SESSION_SECRET: 'integration-session-secret' });

describe('sandbox rewarded ads', () => {
  it('grants a verified callback exactly once', async () => {
    const economy = new EconomyService(new InMemoryEconomyRepository(), new WalletLockService());
    const provider = new SandboxAdProvider(env);
    const ads = new AdsService(new InMemoryAdsRepository(), provider, economy);
    const issued = await ads.issue('p1', 'daily-coins');
    const unsigned = { tokenId: issued.tokenId, providerEventId: 'ad-event-1', status: 'completed' as const };
    const callback = { ...unsigned, signature: provider.signCallback(unsigned) };
    await Promise.all([ads.callback(callback), ads.callback(callback)]);
    expect((await economy.wallet('p1')).soft).toBe(50);
  });
});
