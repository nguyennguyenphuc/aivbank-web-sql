import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service.js';
import type { EconomyRepository } from './economy.repository.js';
import type { EconomyAudit, EconomyCommit, JournalEntry, LedgerLine, WalletSnapshot } from './economy.types.js';

interface WalletDbRow { [key: string]: unknown; soft_currency: string; hard_currency: string; revision: number }
interface JournalDbRow {
  [key: string]: unknown;
  journal_id: string; account_id: string; idempotency_key: string; fingerprint: string;
  reason: string; reference_id: string; reversal_of: string | null; created_at: Date;
}

@Injectable()
export class PostgresEconomyRepository implements EconomyRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async wallet(accountId: string): Promise<WalletSnapshot> {
    await this.database.query(`insert into wallets (wallet_id, account_id) values (gen_random_uuid(), $1) on conflict (account_id) do nothing`, [accountId]);
    return this.readWallet(accountId);
  }

  async commit(accountId: string, command: EconomyCommit): Promise<WalletSnapshot> {
    return this.database.withClient(async client => {
      await client.query('begin');
      try {
        await client.query(`insert into wallets (wallet_id, account_id) values (gen_random_uuid(), $1) on conflict (account_id) do nothing`, [accountId]);
        await client.query('select wallet_id from wallets where account_id = $1 for update', [accountId]);
        if (command.journal) {
          const prior = await client.query<JournalDbRow>('select * from economy_journals where idempotency_key = $1', [command.journal.idempotencyKey]);
          if (prior.rows[0]) {
            if (prior.rows[0].fingerprint !== command.journal.fingerprint) throw new ConflictException('Idempotency key reused for another command');
            const wallet = await this.readWalletClient(client, accountId);
            await client.query('commit');
            return wallet;
          }
        }
        if (command.claimId && (await client.query('select claim_id from reward_claims where claim_id = $1', [command.claimId])).rowCount) {
          throw new ConflictException('Reward already claimed');
        }
        const deltas = this.currencyDeltas(accountId, command.journal?.lines ?? []);
        const current = await client.query<WalletDbRow>('select soft_currency, hard_currency, revision from wallets where account_id = $1', [accountId]);
        const soft = Number(current.rows[0].soft_currency) + deltas.soft;
        const hard = Number(current.rows[0].hard_currency) + deltas.hard;
        if (soft < 0 || hard < 0) throw new ConflictException('Insufficient currency');
        await this.insertJournal(client, command.journal);
        await this.updateInventory(client, accountId, command.inventoryDeltas ?? {});
        await client.query(
          `update wallets set soft_currency = $2, hard_currency = $3, revision = revision + 1,
           lifetime_earned = lifetime_earned + $4, lifetime_spent = lifetime_spent + $5, updated_at = now() where account_id = $1`,
          [accountId, soft, hard, Math.max(0, deltas.soft) + Math.max(0, deltas.hard), Math.max(0, -deltas.soft) + Math.max(0, -deltas.hard)],
        );
        if (command.claimId && command.journal) await client.query('insert into reward_claims (claim_id, account_id, journal_id) values ($1, $2, $3)', [command.claimId, accountId, command.journal.journalId]);
        await client.query(
          `insert into audit_log (actor_account_id, entity_type, entity_id, action, request_id, payload)
           values ($1, $2, $3, $4, $5, '{}'::jsonb)`,
          [command.audit.actorAccountId, command.audit.entityType, command.audit.entityId, command.audit.action, command.audit.auditId],
        );
        const wallet = await this.readWalletClient(client, accountId);
        await client.query('commit');
        return wallet;
      } catch (error) {
        await client.query('rollback');
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
          throw new ConflictException('Economy command conflicts with an existing record');
        }
        throw error;
      }
    });
  }

  async journalByKey(idempotencyKey: string): Promise<JournalEntry | undefined> {
    const rows = await this.database.query<JournalDbRow>('select * from economy_journals where idempotency_key = $1', [idempotencyKey]);
    return rows[0] ? this.readJournal(rows[0]) : undefined;
  }

  async journalById(journalId: string): Promise<JournalEntry | undefined> {
    const rows = await this.database.query<JournalDbRow>('select * from economy_journals where journal_id = $1', [journalId]);
    return rows[0] ? this.readJournal(rows[0]) : undefined;
  }

  async isClaimed(claimId: string): Promise<boolean> {
    return (await this.database.query<Record<string, unknown>>('select claim_id from reward_claims where claim_id = $1', [claimId])).length === 1;
  }

  async auditLog(accountId: string): Promise<EconomyAudit[]> {
    const rows = await this.database.query<{
      [key: string]: unknown; request_id: string; actor_account_id: string; action: string;
      entity_type: 'journal'; entity_id: string; created_at: Date;
    }>(`select request_id, actor_account_id, action, entity_type, entity_id, created_at from audit_log
       where actor_account_id = $1 and entity_type = 'journal' order by audit_id`, [accountId]);
    return rows.map(row => ({ auditId: row.request_id, actorAccountId: row.actor_account_id, action: row.action, entityType: row.entity_type, entityId: row.entity_id, createdAt: row.created_at.toISOString() }));
  }

  private async insertJournal(client: PoolClient, journal?: JournalEntry): Promise<void> {
    if (!journal) return;
    if (journal.lines.reduce((sum, line) => sum + line.amount, 0) !== 0) throw new Error('Unbalanced journal entry');
    await client.query(
      `insert into economy_journals (journal_id, account_id, idempotency_key, fingerprint, reason, reference_id, reversal_of, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [journal.journalId, journal.accountId, journal.idempotencyKey, journal.fingerprint, journal.reason, journal.referenceId, journal.reversalOf ?? null, journal.createdAt],
    );
    for (const line of journal.lines) await client.query('insert into economy_journal_lines (journal_id, ledger_account, amount) values ($1, $2, $3)', [journal.journalId, line.account, line.amount]);
  }

  private async updateInventory(client: PoolClient, accountId: string, deltas: Record<string, number>): Promise<void> {
    for (const [itemId, delta] of Object.entries(deltas)) {
      const result = await client.query<{ quantity: number }>('select quantity from inventory_items where account_id = $1 and item_id = $2 for update', [accountId, itemId]);
      const quantity = (result.rows[0]?.quantity ?? 0) + delta;
      if (quantity < 0) throw new ConflictException(`Insufficient inventory: ${itemId}`);
      await client.query(`insert into inventory_items (account_id, item_id, quantity) values ($1, $2, $3)
        on conflict (account_id, item_id) do update set quantity = excluded.quantity, updated_at = now()`, [accountId, itemId, quantity]);
    }
  }

  private async readJournal(row: JournalDbRow): Promise<JournalEntry> {
    const lines = await this.database.query<{ [key: string]: unknown; ledger_account: string; amount: string }>('select ledger_account, amount from economy_journal_lines where journal_id = $1 order by line_id', [row.journal_id]);
    return { journalId: row.journal_id, accountId: row.account_id, idempotencyKey: row.idempotency_key, fingerprint: row.fingerprint, reason: row.reason, referenceId: row.reference_id, lines: lines.map(line => ({ account: line.ledger_account, amount: Number(line.amount) })), reversalOf: row.reversal_of ?? undefined, createdAt: row.created_at.toISOString() };
  }

  private async readWallet(accountId: string): Promise<WalletSnapshot> {
    const wallets = await this.database.query<WalletDbRow>('select soft_currency, hard_currency, revision from wallets where account_id = $1', [accountId]);
    const items = await this.database.query<{ [key: string]: unknown; item_id: string; quantity: number }>('select item_id, quantity from inventory_items where account_id = $1', [accountId]);
    return this.snapshot(accountId, wallets[0], items);
  }

  private async readWalletClient(client: PoolClient, accountId: string): Promise<WalletSnapshot> {
    const wallets = await client.query<WalletDbRow>('select soft_currency, hard_currency, revision from wallets where account_id = $1', [accountId]);
    const items = await client.query<{ item_id: string; quantity: number }>('select item_id, quantity from inventory_items where account_id = $1', [accountId]);
    return this.snapshot(accountId, wallets.rows[0], items.rows);
  }

  private snapshot(accountId: string, wallet: WalletDbRow, items: { item_id: string; quantity: number }[]): WalletSnapshot {
    return { accountId, soft: Number(wallet.soft_currency), hard: Number(wallet.hard_currency), inventory: Object.fromEntries(items.map(item => [item.item_id, item.quantity])), revision: wallet.revision };
  }

  private currencyDeltas(accountId: string, lines: LedgerLine[]): { soft: number; hard: number } {
    return { soft: lines.find(line => line.account === `player:${accountId}:soft`)?.amount ?? 0, hard: lines.find(line => line.account === `player:${accountId}:hard`)?.amount ?? 0 };
  }
}
