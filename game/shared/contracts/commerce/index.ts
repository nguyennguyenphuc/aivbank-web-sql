import type { RewardGrant, WalletSnapshot } from '../economy/index.js';

export interface ShopProduct {
  productId: string;
  priceCurrency: 'soft' | 'hard' | 'USD';
  price: number;
  grants: RewardGrant[];
}

export interface PurchaseIntent {
  intentId: string;
  provider: string;
  productId: string;
  callbackToken: string;
}

export interface PurchaseResult {
  receiptId: string;
  status: 'settled' | 'refunded';
  wallet: WalletSnapshot;
}
