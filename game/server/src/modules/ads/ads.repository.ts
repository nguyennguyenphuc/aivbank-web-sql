import { Injectable } from '@nestjs/common';
import type { WalletSnapshot } from '../economy/economy.types.js';

export interface AdRewardTokenRow {
  tokenId: string;
  accountId: string;
  placement: string;
  provider: string;
  status: 'issued' | 'granted';
  expiresAt: number;
  providerEventId?: string;
  wallet?: WalletSnapshot;
}

export const ADS_REPOSITORY = Symbol('ADS_REPOSITORY');

export interface AdsRepository {
  save(row: AdRewardTokenRow): Promise<void>;
  find(tokenId: string): Promise<AdRewardTokenRow | undefined>;
  findByEvent(providerEventId: string): Promise<AdRewardTokenRow | undefined>;
}

@Injectable()
export class InMemoryAdsRepository implements AdsRepository {
  private readonly rows = new Map<string, AdRewardTokenRow>();
  private readonly events = new Map<string, string>();
  async save(row: AdRewardTokenRow): Promise<void> {
    this.rows.set(row.tokenId, structuredClone(row));
    if (row.providerEventId) this.events.set(row.providerEventId, row.tokenId);
  }
  async find(tokenId: string): Promise<AdRewardTokenRow | undefined> { return this.clone(this.rows.get(tokenId)); }
  async findByEvent(providerEventId: string): Promise<AdRewardTokenRow | undefined> {
    const tokenId = this.events.get(providerEventId);
    return tokenId ? this.find(tokenId) : undefined;
  }
  private clone<T>(value: T | undefined): T | undefined { return value ? structuredClone(value) : undefined; }
}
