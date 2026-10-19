import type { CurrencyCode, RewardGrant, WalletSnapshot } from '../economy/economy.types.js';

export interface ShopProduct {
  productId: string;
  priceCurrency: CurrencyCode | 'USD';
  price: number;
  grants: RewardGrant[];
}

export interface PaymentIntentRow {
  intentId: string;
  accountId: string;
  productId: string;
  provider: string;
  status: 'pending' | 'settled' | 'refunded';
  createdAt: string;
}

export interface PurchaseReceiptRow {
  receiptId: string;
  intentId: string;
  providerEventId: string;
  journalId: string;
  status: 'settled' | 'refunded';
  wallet: WalletSnapshot;
}

export interface ProviderCallback {
  intentId: string;
  providerEventId: string;
  status: 'paid' | 'failed';
  signature: string;
}
