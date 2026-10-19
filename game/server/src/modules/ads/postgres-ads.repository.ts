import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import type { AdRewardTokenRow, AdsRepository } from './ads.repository.js';

interface AdDbRow {
  [key: string]: unknown;
  token_id: string; account_id: string; placement: string; provider: string;
  status: AdRewardTokenRow['status']; expires_at: Date; provider_event_id: string | null;
  wallet_snapshot: AdRewardTokenRow['wallet'] | null;
}

@Injectable()
export class PostgresAdsRepository implements AdsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async save(row: AdRewardTokenRow): Promise<void> {
    await this.database.query(
      `insert into ad_reward_tokens (token_id, account_id, placement, provider, status, expires_at, provider_event_id, wallet_snapshot)
       values ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), $7, $8::jsonb)
       on conflict (token_id) do update set status = excluded.status, provider_event_id = excluded.provider_event_id,
       wallet_snapshot = excluded.wallet_snapshot, updated_at = now()
       where ad_reward_tokens.status <> 'granted' or ad_reward_tokens.provider_event_id = excluded.provider_event_id`,
      [row.tokenId, row.accountId, row.placement, row.provider, row.status, row.expiresAt, row.providerEventId ?? null, row.wallet ? JSON.stringify(row.wallet) : null],
    );
  }

  async find(tokenId: string): Promise<AdRewardTokenRow | undefined> {
    const rows = await this.database.query<AdDbRow>('select * from ad_reward_tokens where token_id = $1', [tokenId]);
    return rows[0] ? this.row(rows[0]) : undefined;
  }

  async findByEvent(providerEventId: string): Promise<AdRewardTokenRow | undefined> {
    const rows = await this.database.query<AdDbRow>('select * from ad_reward_tokens where provider_event_id = $1', [providerEventId]);
    return rows[0] ? this.row(rows[0]) : undefined;
  }

  private row(row: AdDbRow): AdRewardTokenRow {
    return { tokenId: row.token_id, accountId: row.account_id, placement: row.placement, provider: row.provider, status: row.status, expiresAt: row.expires_at.getTime(), providerEventId: row.provider_event_id ?? undefined, wallet: row.wallet_snapshot ?? undefined };
  }
}
