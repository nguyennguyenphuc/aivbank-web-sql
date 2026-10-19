import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import type { AuthRepository } from './auth.repository.js';
import type { AuthAccountRow, AuthSessionRow, PlayerRole } from './auth.types.js';

interface AccountDbRow {
  [key: string]: unknown;
  account_id: string;
  email: string | null;
  password_hash: string | null;
  display_name: string;
  is_guest: boolean;
  created_at: Date;
  roles: string[] | null;
}

interface SessionDbRow {
  [key: string]: unknown;
  session_id: string;
  account_id: string;
  device_id: string | null;
  refresh_token_hash: string;
  rotation: number;
  expires_at: Date;
  revoked_at: Date | null;
}

@Injectable()
export class PostgresAuthRepository implements AuthRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async createAccount(row: AuthAccountRow): Promise<void> {
    await this.database.withClient(async client => {
      await client.query('begin');
      try {
        await client.query(
          `insert into accounts (account_id, email, password_hash, display_name, is_guest, created_at)
           values ($1, $2, $3, $4, $5, $6)`,
          [row.accountId, row.email ?? null, row.passwordHash ?? null, row.displayName, row.guest, row.createdAt],
        );
        for (const role of row.roles) {
          await client.query('insert into role_grants (grant_id, account_id, role) values (gen_random_uuid(), $1, $2) on conflict do nothing', [row.accountId, role]);
        }
        await client.query(
          'insert into player_profiles (account_id, display_name) values ($1, $2) on conflict (account_id) do nothing',
          [row.accountId, row.displayName],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    });
  }

  async findAccount(accountId: string): Promise<AuthAccountRow | undefined> {
    const rows = await this.database.query<AccountDbRow>(this.accountQuery('a.account_id = $1'), [accountId]);
    return rows[0] ? this.account(rows[0]) : undefined;
  }

  async findAccountByEmail(email: string): Promise<AuthAccountRow | undefined> {
    const rows = await this.database.query<AccountDbRow>(this.accountQuery('lower(a.email) = lower($1)'), [email]);
    return rows[0] ? this.account(rows[0]) : undefined;
  }

  async updateAccount(accountId: string, patch: Partial<AuthAccountRow>): Promise<AuthAccountRow> {
    const current = await this.findAccount(accountId);
    if (!current) throw new Error('Account not found');
    await this.database.query(
      `update accounts set email = $2, password_hash = $3, display_name = $4, is_guest = $5, updated_at = now()
       where account_id = $1`,
      [accountId, patch.email ?? current.email ?? null, patch.passwordHash ?? current.passwordHash ?? null, patch.displayName ?? current.displayName, patch.guest ?? current.guest],
    );
    return (await this.findAccount(accountId))!;
  }

  async saveSession(row: AuthSessionRow): Promise<void> {
    await this.database.query(
      `insert into auth_sessions (session_id, account_id, session_token_hash, refresh_token_hash, device_id, rotation, expires_at, revoked_at)
       values ($1, $2, '', $3, $4, $5, to_timestamp($6 / 1000.0), $7)
       on conflict (session_id) do update set refresh_token_hash = excluded.refresh_token_hash,
       device_id = excluded.device_id, rotation = excluded.rotation, expires_at = excluded.expires_at,
       revoked_at = excluded.revoked_at, updated_at = now()`,
      [row.sessionId, row.accountId, row.refreshTokenHash, row.deviceId, row.rotation, row.expiresAt, row.revokedAt ? new Date(row.revokedAt) : null],
    );
  }

  async findSession(sessionId: string): Promise<AuthSessionRow | undefined> {
    const rows = await this.database.query<SessionDbRow>(
      `select session_id, account_id, device_id, refresh_token_hash, rotation, expires_at, revoked_at
       from auth_sessions where session_id = $1 and deleted_at is null`,
      [sessionId],
    );
    const row = rows[0];
    return row ? { sessionId: row.session_id, accountId: row.account_id, deviceId: row.device_id ?? '', refreshTokenHash: row.refresh_token_hash, rotation: row.rotation, expiresAt: row.expires_at.getTime(), revokedAt: row.revoked_at?.getTime() } : undefined;
  }

  async updateSession(sessionId: string, patch: Partial<AuthSessionRow>): Promise<AuthSessionRow> {
    const current = await this.findSession(sessionId);
    if (!current) throw new Error('Session not found');
    const updated = { ...current, ...patch, sessionId };
    await this.saveSession(updated);
    return updated;
  }

  async rotateSession(row: AuthSessionRow, expectedRotation: number, expectedHash: string): Promise<boolean> {
    const result = await this.database.query<Record<string, unknown>>(
      `update auth_sessions set refresh_token_hash = $2, device_id = $3, rotation = $4,
       expires_at = to_timestamp($5 / 1000.0), revoked_at = null, updated_at = now()
       where session_id = $1 and rotation = $6 and refresh_token_hash = $7 and revoked_at is null
       returning session_id`,
      [row.sessionId, row.refreshTokenHash, row.deviceId, row.rotation, row.expiresAt, expectedRotation, expectedHash],
    );
    return result.length === 1;
  }

  async consumeSsoTicket(jti: string, expiresAt: number): Promise<boolean> {
    await this.database.query('delete from aivb_sso_used_tickets where expires_at < now()');
    const rows = await this.database.query<{ jti: string }>(
      'insert into aivb_sso_used_tickets (jti, expires_at) values ($1, $2) on conflict (jti) do nothing returning jti',
      [jti, new Date(expiresAt)],
    );
    return rows.length === 1;
  }

  async upsertAivbAccount(username: string, displayName: string, role: 'student' | 'instructor'): Promise<string> {
    const rows = await this.database.query<{ account_id: string }>(
      'select aivb_upsert_account($1, $2, $3) as account_id',
      [username, displayName, role],
    );
    if (!rows[0]) throw new Error('aivb_upsert_account returned no row');
    return rows[0].account_id;
  }

  async grantRole(accountId: string, role: PlayerRole): Promise<AuthAccountRow> {
    await this.database.query('insert into role_grants (grant_id, account_id, role) values (gen_random_uuid(), $1, $2) on conflict do nothing', [accountId, role]);
    const account = await this.findAccount(accountId);
    if (!account) throw new Error('Account not found');
    return account;
  }

  private accountQuery(predicate: string): string {
    return `select a.account_id, a.email, a.password_hash, a.display_name, a.is_guest, a.created_at,
      coalesce(array_agg(r.role) filter (where r.role is not null), '{}') as roles
      from accounts a left join role_grants r on r.account_id = a.account_id
      where ${predicate} and a.deleted_at is null group by a.account_id`;
  }

  private account(row: AccountDbRow): AuthAccountRow {
    return { accountId: row.account_id, email: row.email ?? undefined, passwordHash: row.password_hash ?? undefined, displayName: row.display_name, guest: row.is_guest, roles: (row.roles ?? []) as PlayerRole[], createdAt: row.created_at.toISOString() };
  }
}
