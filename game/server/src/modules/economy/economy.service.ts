import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { ECONOMY_REPOSITORY, type EconomyRepository } from './economy.repository.js';
import type { CurrencyCode, EconomyCommit, JournalEntry, RewardGrant, WalletSnapshot } from './economy.types.js';
import { WalletLockService } from './wallet-lock.service.js';

type BoosterType = 'hammer' | 'shuffle' | 'lightning' | 'extraMoves';

@Injectable()
export class EconomyService {
  constructor(
    @Inject(ECONOMY_REPOSITORY) private readonly repository: EconomyRepository,
    @Inject(WalletLockService) private readonly locks: WalletLockService,
  ) {}

  wallet(accountId: string): Promise<WalletSnapshot> {
    return this.repository.wallet(accountId);
  }

  isClaimed(claimId: string): Promise<boolean> {
    return this.repository.isClaimed(claimId);
  }

  journalByKey(accountId: string, idempotencyKey: string): Promise<JournalEntry | undefined> {
    return this.repository.journalByKey(this.scopedKey(accountId, idempotencyKey));
  }

  async postCurrency(accountId: string, currency: CurrencyCode, amount: number, reason: string, referenceId: string, key: string): Promise<WalletSnapshot> {
    if (!Number.isSafeInteger(amount) || amount === 0) throw new BadRequestException('Currency amount must be a non-zero integer');
    return this.locks.run(accountId, async () => {
      const journal = this.journal(accountId, currency, amount, reason, referenceId, this.scopedKey(accountId, key));
      return this.repository.commit(accountId, { journal, audit: this.audit(accountId, reason, journal.journalId) });
    });
  }

  async grant(accountId: string, grants: RewardGrant[], reason: string, referenceId: string, key: string, claimId?: string): Promise<WalletSnapshot> {
    if (!key.trim()) throw new BadRequestException('Idempotency key is required');
    return this.locks.run(accountId, async () => {
      const currencyTotals: Record<CurrencyCode, number> = { soft: 0, hard: 0 };
      const inventoryDeltas: Record<string, number> = {};
      for (const grant of grants) {
        if (grant.currency) currencyTotals[grant.currency] += this.positive(grant.amount, 'reward amount');
        if (grant.itemId) inventoryDeltas[grant.itemId] = (inventoryDeltas[grant.itemId] ?? 0) + this.positive(grant.quantity, 'item quantity');
      }
      const lines = (Object.entries(currencyTotals) as [CurrencyCode, number][]).flatMap(([currency, amount]) => amount === 0 ? [] : [
        { account: `player:${accountId}:${currency}`, amount },
        { account: `system:${reason}:${currency}`, amount: -amount },
      ]);
      const fingerprint = this.fingerprint({ accountId, grants, reason, referenceId, claimId });
      const scopedKey = this.scopedKey(accountId, key);
      const journal = this.makeJournal(accountId, scopedKey, fingerprint, reason, referenceId, lines);
      const existing = await this.repository.journalByKey(scopedKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ConflictException('Idempotency key reused for another command');
        return this.repository.wallet(accountId);
      }
      return this.repository.commit(accountId, { journal, inventoryDeltas, claimId, audit: this.audit(accountId, reason, journal.journalId) });
    });
  }

  async spend(accountId: string, currency: CurrencyCode, amount: number, reason: string, referenceId: string, key: string, grants: RewardGrant[] = []): Promise<WalletSnapshot> {
    const cost = this.positive(amount, 'cost');
    return this.locks.run(accountId, async () => {
      const fingerprint = this.fingerprint({ accountId, currency, cost, reason, referenceId, grants });
      const scopedKey = this.scopedKey(accountId, key);
      const existing = await this.repository.journalByKey(scopedKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ConflictException('Idempotency key reused for another command');
        return this.repository.wallet(accountId);
      }
      const journal = this.makeJournal(accountId, scopedKey, fingerprint, reason, referenceId, [
        { account: `player:${accountId}:${currency}`, amount: -cost },
        { account: `system:${reason}:${currency}`, amount: cost },
      ]);
      const inventoryDeltas: Record<string, number> = {};
      for (const grant of grants) if (grant.itemId) inventoryDeltas[grant.itemId] = this.positive(grant.quantity, 'item quantity');
      return this.repository.commit(accountId, { journal, inventoryDeltas, audit: this.audit(accountId, reason, journal.journalId) });
    });
  }

  async useBooster(accountId: string, booster: BoosterType, referenceId: string, key: string): Promise<WalletSnapshot> {
    if (typeof referenceId !== 'string' || !referenceId.trim() || referenceId.length > 160) {
      throw new BadRequestException('Booster referenceId is required and must be at most 160 characters');
    }
    const itemId = this.boosterItemId(booster);
    return this.locks.run(accountId, async () => {
      const scopedKey = this.scopedKey(accountId, key);
      const fingerprint = this.fingerprint({ accountId, booster, referenceId: referenceId.trim(), itemId });
      const existing = await this.repository.journalByKey(scopedKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ConflictException('Idempotency key reused for another command');
        return this.repository.wallet(accountId);
      }
      const journal = this.makeJournal(accountId, scopedKey, fingerprint, 'use-booster', referenceId.trim(), []);
      return this.repository.commit(accountId, {
        journal,
        inventoryDeltas: { [itemId]: -1 },
        audit: this.audit(accountId, 'use-booster', journal.journalId),
      });
    });
  }

  async reverse(accountId: string, journalId: string, key: string): Promise<WalletSnapshot> {
    return this.locks.run(accountId, async () => {
      const original = await this.repository.journalById(journalId);
      if (!original || original.accountId !== accountId) throw new BadRequestException('Journal entry not found');
      const fingerprint = this.fingerprint({ accountId, journalId, reversal: true });
      const reversal = this.makeJournal(accountId, this.scopedKey(accountId, key), fingerprint, 'reversal', journalId, original.lines.map(line => ({ ...line, amount: -line.amount })), journalId);
      return this.repository.commit(accountId, { journal: reversal, audit: this.audit(accountId, 'reversal', reversal.journalId) });
    });
  }

  private journal(accountId: string, currency: CurrencyCode, amount: number, reason: string, referenceId: string, key: string): JournalEntry {
    const fingerprint = this.fingerprint({ accountId, currency, amount, reason, referenceId });
    return this.makeJournal(accountId, key, fingerprint, reason, referenceId, [
      { account: `player:${accountId}:${currency}`, amount },
      { account: `system:${reason}:${currency}`, amount: -amount },
    ]);
  }

  private makeJournal(accountId: string, key: string, fingerprint: string, reason: string, referenceId: string, lines: JournalEntry['lines'], reversalOf?: string): JournalEntry {
    if (!key.trim()) throw new BadRequestException('Idempotency key is required');
    return { journalId: randomUUID(), accountId, idempotencyKey: key, fingerprint, reason, referenceId, lines, reversalOf, createdAt: new Date().toISOString() };
  }

  private fingerprint(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private positive(value: number | undefined, label: string): number {
    if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) throw new BadRequestException(`${label} must be a positive integer`);
    return value as number;
  }

  private boosterItemId(booster: BoosterType): string {
    switch (booster) {
      case 'hammer':
      case 'shuffle':
      case 'lightning':
      case 'extraMoves':
        return booster;
      default:
        throw new BadRequestException('Unsupported booster type');
    }
  }

  private scopedKey(accountId: string, key: string): string {
    if (!key.trim()) throw new BadRequestException('Idempotency key is required');
    return `${accountId}:${key}`;
  }

  private audit(accountId: string, action: string, entityId: string) {
    return { auditId: randomUUID(), actorAccountId: accountId, action, entityType: 'journal' as const, entityId, createdAt: new Date().toISOString() };
  }
}
