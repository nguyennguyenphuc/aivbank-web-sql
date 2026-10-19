import { Injectable } from '@nestjs/common';
import type { PaymentIntentRow, PurchaseReceiptRow } from './commerce.types.js';

export const COMMERCE_REPOSITORY = Symbol('COMMERCE_REPOSITORY');

export interface CommerceRepository {
  saveIntent(intent: PaymentIntentRow): Promise<void>;
  intent(intentId: string): Promise<PaymentIntentRow | undefined>;
  updateIntent(intentId: string, status: PaymentIntentRow['status']): Promise<void>;
  saveReceipt(receipt: PurchaseReceiptRow): Promise<void>;
  receiptByIntent(intentId: string): Promise<PurchaseReceiptRow | undefined>;
  receiptByEvent(providerEventId: string): Promise<PurchaseReceiptRow | undefined>;
}

@Injectable()
export class InMemoryCommerceRepository implements CommerceRepository {
  private readonly intents = new Map<string, PaymentIntentRow>();
  private readonly receipts = new Map<string, PurchaseReceiptRow>();
  private readonly events = new Map<string, string>();

  async saveIntent(intent: PaymentIntentRow): Promise<void> { this.intents.set(intent.intentId, structuredClone(intent)); }
  async intent(intentId: string): Promise<PaymentIntentRow | undefined> { return this.clone(this.intents.get(intentId)); }
  async updateIntent(intentId: string, status: PaymentIntentRow['status']): Promise<void> {
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error('Payment intent not found');
    this.intents.set(intentId, { ...intent, status });
  }
  async saveReceipt(receipt: PurchaseReceiptRow): Promise<void> {
    this.receipts.set(receipt.intentId, structuredClone(receipt));
    this.events.set(receipt.providerEventId, receipt.intentId);
  }
  async receiptByIntent(intentId: string): Promise<PurchaseReceiptRow | undefined> { return this.clone(this.receipts.get(intentId)); }
  async receiptByEvent(providerEventId: string): Promise<PurchaseReceiptRow | undefined> {
    const intentId = this.events.get(providerEventId);
    return intentId ? this.receiptByIntent(intentId) : undefined;
  }
  private clone<T>(value: T | undefined): T | undefined { return value ? structuredClone(value) : undefined; }
}
