export type CurrencyCode = 'soft' | 'hard';
export type LedgerAccount = `player:${string}:${CurrencyCode}` | `system:${string}:${CurrencyCode}`;

export interface LedgerLine {
  account: LedgerAccount;
  amount: number;
}

export interface JournalEntry {
  journalId: string;
  idempotencyKey: string;
  reason: string;
  referenceId: string;
  lines: LedgerLine[];
  reversalOf?: string;
  createdAt: string;
}

export interface WalletSnapshot {
  accountId: string;
  soft: number;
  hard: number;
  inventory: Record<string, number>;
  revision: number;
}

export interface DailyGiftStatus {
  day: string;
  claimed: boolean;
  amount: number;
  nextClaimAt: string;
}

export interface DailyGiftClaimResult {
  wallet: WalletSnapshot;
  dailyGift: DailyGiftStatus;
}

export interface RewardGrant {
  currency?: CurrencyCode;
  amount?: number;
  itemId?: string;
  quantity?: number;
}
