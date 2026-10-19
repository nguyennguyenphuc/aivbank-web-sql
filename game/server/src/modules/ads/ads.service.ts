import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { EconomyService } from '../economy/economy.service.js';
import type { WalletSnapshot } from '../economy/economy.types.js';
import { LiveProjectionService } from '../live-projection/live-projection.service.js';
import { AD_PROVIDER, type AdCallback, type AdProvider } from './ad-provider.js';
import { ADS_REPOSITORY, type AdsRepository } from './ads.repository.js';

const PLACEMENTS = new Set(['defeat-extra-moves', 'daily-coins']);

@Injectable()
export class AdsService {
  private readonly callbackTails = new Map<string, Promise<void>>();

  constructor(
    @Inject(ADS_REPOSITORY) private readonly repository: AdsRepository,
    @Inject(AD_PROVIDER) private readonly provider: AdProvider,
    @Inject(EconomyService) private readonly economy: EconomyService,
    @Optional() @Inject(LiveProjectionService) private readonly projection?: LiveProjectionService,
  ) {}

  async issue(accountId: string, placement: string): Promise<{ tokenId: string; provider: string; adToken: string }> {
    if (!PLACEMENTS.has(placement)) throw new BadRequestException('Unknown ad placement');
    const tokenId = randomUUID();
    await this.repository.save({ tokenId, accountId, placement, provider: this.provider.name, status: 'issued', expiresAt: Date.now() + 10 * 60_000 });
    return { tokenId, provider: this.provider.name, ...await this.provider.issue(tokenId, placement) };
  }

  async callback(callback: AdCallback): Promise<{ tokenId: string; wallet: WalletSnapshot }> {
    if (!await this.provider.verify(callback)) throw new UnauthorizedException('Invalid ad callback signature');
    return this.withCallbackLock(callback.tokenId, () => this.settleVerifiedCallback(callback));
  }

  private async settleVerifiedCallback(callback: AdCallback): Promise<{ tokenId: string; wallet: WalletSnapshot }> {
    const duplicate = await this.repository.findByEvent(callback.providerEventId);
    if (duplicate?.wallet) return { tokenId: duplicate.tokenId, wallet: duplicate.wallet };
    const token = await this.repository.find(callback.tokenId);
    if (!token || token.expiresAt <= Date.now()) throw new BadRequestException('Ad reward token is invalid or expired');
    if (token.status === 'granted' && token.wallet) return { tokenId: token.tokenId, wallet: token.wallet };
    if (callback.status !== 'completed') throw new BadRequestException('Ad was not completed');
    const grants = token.placement === 'defeat-extra-moves'
      ? [{ itemId: 'extra-moves-5', quantity: 1 }]
      : [{ currency: 'soft' as const, amount: 50 }];
    const wallet = await this.economy.grant(token.accountId, grants, 'rewarded-ad', token.tokenId, `ad:${token.tokenId}`, `ad-reward:${token.tokenId}`);
    await this.repository.save({ ...token, status: 'granted', providerEventId: callback.providerEventId, wallet });
    await this.projection?.adReward(token.accountId, { tokenId: token.tokenId, placement: token.placement });
    const persisted = await this.repository.find(token.tokenId);
    return { tokenId: token.tokenId, wallet: persisted?.wallet ?? wallet };
  }

  private async withCallbackLock<T>(tokenId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.callbackTails.get(tokenId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = prior.then(() => current);
    this.callbackTails.set(tokenId, tail);
    await prior;
    try { return await operation(); } finally {
      release();
      if (this.callbackTails.get(tokenId) === tail) this.callbackTails.delete(tokenId);
    }
  }
}
