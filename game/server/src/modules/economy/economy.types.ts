export type CurrencyCode = 'soft' | 'hard';

export interface LedgerLine {
  account: string;
  amount: number;
}

export interface JournalEntry {
  journalId: string;
  accountId: string;
  idempotencyKey: string;
  fingerprint: string;
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

export interface RewardGrant {
  currency?: CurrencyCode;
  amount?: number;
  itemId?: string;
  quantity?: number;
}

export interface EconomyCommit {
  journal?: JournalEntry;
  inventoryDeltas?: Record<string, number>;
  claimId?: string;
  audit: EconomyAudit;
}

export interface EconomyAudit {
  auditId: string;
  actorAccountId: string;
  action: string;
  entityType: 'wallet' | 'journal';
  entityId: string;
  createdAt: string;
}
