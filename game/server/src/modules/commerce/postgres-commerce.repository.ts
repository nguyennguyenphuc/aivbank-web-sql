import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import type { CommerceRepository } from './commerce.repository.js';
import type { PaymentIntentRow, PurchaseReceiptRow } from './commerce.types.js';

interface IntentDbRow {
  [key: string]: unknown;
  intent_id: string; account_id: string; product_id: string; provider: string;
  status: PaymentIntentRow['status']; created_at: Date;
}
interface ReceiptDbRow {
  [key: string]: unknown;
  receipt_id: string; intent_id: string; provider_event_id: string; journal_id: string;
  status: PurchaseReceiptRow['status']; wallet_snapshot: PurchaseReceiptRow['wallet'];
}

@Injectable()
export class PostgresCommerceRepository implements CommerceRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async saveIntent(intent: PaymentIntentRow): Promise<void> {
    await this.database.query(
      `insert into payment_intents (intent_id, account_id, product_id, provider, status, created_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [intent.intentId, intent.accountId, intent.productId, intent.provider, intent.status, intent.createdAt],
    );
  }

  async intent(intentId: string): Promise<PaymentIntentRow | undefined> {
    const rows = await this.database.query<IntentDbRow>('select * from payment_intents where intent_id = $1', [intentId]);
    const row = rows[0];
    return row ? { intentId: row.intent_id, accountId: row.account_id, productId: row.product_id, provider: row.provider, status: row.status, createdAt: row.created_at.toISOString() } : undefined;
  }

  async updateIntent(intentId: string, status: PaymentIntentRow['status']): Promise<void> {
    await this.database.query('update payment_intents set status = $2, updated_at = now() where intent_id = $1', [intentId, status]);
  }

  async saveReceipt(receipt: PurchaseReceiptRow): Promise<void> {
    await this.database.query(
      `insert into purchase_receipts (receipt_id, intent_id, provider_event_id, journal_id, status, wallet_snapshot)
       values ($1, $2, $3, $4, $5, $6::jsonb) on conflict (intent_id) do update set
       status = excluded.status, wallet_snapshot = excluded.wallet_snapshot, updated_at = now()`,
      [receipt.receiptId, receipt.intentId, receipt.providerEventId, receipt.journalId, receipt.status, JSON.stringify(receipt.wallet)],
    );
  }

  async receiptByIntent(intentId: string): Promise<PurchaseReceiptRow | undefined> {
    const rows = await this.database.query<ReceiptDbRow>('select * from purchase_receipts where intent_id = $1', [intentId]);
    return rows[0] ? this.receipt(rows[0]) : undefined;
  }

  async receiptByEvent(providerEventId: string): Promise<PurchaseReceiptRow | undefined> {
    const rows = await this.database.query<ReceiptDbRow>('select * from purchase_receipts where provider_event_id = $1', [providerEventId]);
    return rows[0] ? this.receipt(rows[0]) : undefined;
  }

  private receipt(row: ReceiptDbRow): PurchaseReceiptRow {
    return { receiptId: row.receipt_id, intentId: row.intent_id, providerEventId: row.provider_event_id, journalId: row.journal_id, status: row.status, wallet: row.wallet_snapshot };
  }
}
