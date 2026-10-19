import { ConflictException, Injectable } from '@nestjs/common';
import type { EconomyAudit, EconomyCommit, JournalEntry, WalletSnapshot } from './economy.types.js';

export const ECONOMY_REPOSITORY = Symbol('ECONOMY_REPOSITORY');

export interface EconomyRepository {
  wallet(accountId: string): Promise<WalletSnapshot>;
  commit(accountId: string, command: EconomyCommit): Promise<WalletSnapshot>;
  journalByKey(idempotencyKey: string): Promise<JournalEntry | undefined>;
  journalById(journalId: string): Promise<JournalEntry | undefined>;
  isClaimed(claimId: string): Promise<boolean>;
  auditLog(accountId: string): Promise<EconomyAudit[]>;
}

@Injectable()
export class InMemoryEconomyRepository implements EconomyRepository {
  private readonly wallets = new Map<string, WalletSnapshot>();
  private readonly journalsByKey = new Map<string, JournalEntry>();
  private readonly journalsById = new Map<string, JournalEntry>();
  private readonly claims = new Set<string>();
  private readonly reversals = new Set<string>();
  private readonly audits: EconomyAudit[] = [];

  async wallet(accountId: string): Promise<WalletSnapshot> {
    const wallet = this.wallets.get(accountId) ?? { accountId, soft: 0, hard: 0, inventory: {}, revision: 0 };
    if (!this.wallets.has(accountId)) this.wallets.set(accountId, wallet);
    return structuredClone(wallet);
  }

  async commit(accountId: string, command: EconomyCommit): Promise<WalletSnapshot> {
    const wallet = await this.wallet(accountId);
    if (command.claimId && this.claims.has(command.claimId)) throw new ConflictException('Reward already claimed');
    if (command.journal) {
      const existing = this.journalsByKey.get(command.journal.idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== command.journal.fingerprint) throw new ConflictException('Idempotency key reused for another command');
        return wallet;
      }
      const total = command.journal.lines.reduce((sum, line) => sum + line.amount, 0);
      if (total !== 0) throw new Error('Unbalanced journal entry');
      if (command.journal.reversalOf && this.reversals.has(command.journal.reversalOf)) {
        throw new ConflictException('Journal entry already reversed');
      }
      for (const currency of ['soft', 'hard'] as const) {
        const amount = command.journal.lines.find(line => line.account === `player:${accountId}:${currency}`)?.amount ?? 0;
        wallet[currency] += amount;
        if (wallet[currency] < 0) throw new ConflictException(`Insufficient ${currency} currency`);
      }
    }
    for (const [itemId, delta] of Object.entries(command.inventoryDeltas ?? {})) {
      const quantity = (wallet.inventory[itemId] ?? 0) + delta;
      if (quantity < 0) throw new ConflictException(`Insufficient inventory: ${itemId}`);
      wallet.inventory[itemId] = quantity;
    }
    // Persist the command only after every balance and inventory invariant has
    // passed. This keeps the in-memory adapter atomic like the PostgreSQL
    // transaction and prevents a failed command from reserving its retry key.
    if (command.journal) {
      this.journalsByKey.set(command.journal.idempotencyKey, structuredClone(command.journal));
      this.journalsById.set(command.journal.journalId, structuredClone(command.journal));
      if (command.journal.reversalOf) this.reversals.add(command.journal.reversalOf);
    }
    if (command.claimId) this.claims.add(command.claimId);
    wallet.revision += 1;
    this.wallets.set(accountId, structuredClone(wallet));
    this.audits.push(structuredClone(command.audit));
    return wallet;
  }

  async journalByKey(idempotencyKey: string): Promise<JournalEntry | undefined> {
    const value = this.journalsByKey.get(idempotencyKey);
    return value ? structuredClone(value) : undefined;
  }

  async journalById(journalId: string): Promise<JournalEntry | undefined> {
    const value = this.journalsById.get(journalId);
    return value ? structuredClone(value) : undefined;
  }

  async isClaimed(claimId: string): Promise<boolean> {
    return this.claims.has(claimId);
  }

  async auditLog(accountId: string): Promise<EconomyAudit[]> {
    return structuredClone(this.audits.filter(audit => audit.actorAccountId === accountId));
  }
}
