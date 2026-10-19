import { Injectable } from '@nestjs/common';
import type { AuthAccountRow, AuthSessionRow, PlayerRole } from './auth.types.js';

export const AUTH_REPOSITORY = Symbol('AUTH_REPOSITORY');

export interface AuthRepository {
  createAccount(row: AuthAccountRow): Promise<void>;
  findAccount(accountId: string): Promise<AuthAccountRow | undefined>;
  findAccountByEmail(email: string): Promise<AuthAccountRow | undefined>;
  updateAccount(accountId: string, patch: Partial<AuthAccountRow>): Promise<AuthAccountRow>;
  saveSession(row: AuthSessionRow): Promise<void>;
  findSession(sessionId: string): Promise<AuthSessionRow | undefined>;
  updateSession(sessionId: string, patch: Partial<AuthSessionRow>): Promise<AuthSessionRow>;
  rotateSession(row: AuthSessionRow, expectedRotation: number, expectedHash: string): Promise<boolean>;
  grantRole(accountId: string, role: PlayerRole): Promise<AuthAccountRow>;
  /** Ghi nhận vé SSO; `false` nếu `jti` đã được dùng. */
  consumeSsoTicket(jti: string, expiresAt: number): Promise<boolean>;
  /** Tạo/cập nhật tài khoản gắn với user AIV Bank, trả `accountId`. */
  upsertAivbAccount(username: string, displayName: string, role: 'student' | 'instructor'): Promise<string>;
}

@Injectable()
export class InMemoryAuthRepository implements AuthRepository {
  private readonly accounts = new Map<string, AuthAccountRow>();
  private readonly sessions = new Map<string, AuthSessionRow>();
  private readonly usedTickets = new Set<string>();
  private readonly aivbIdentities = new Map<string, string>();

  async createAccount(row: AuthAccountRow): Promise<void> {
    if (row.email && await this.findAccountByEmail(row.email)) throw new Error('Email already registered');
    this.accounts.set(row.accountId, structuredClone(row));
  }

  async findAccount(accountId: string): Promise<AuthAccountRow | undefined> {
    return this.clone(this.accounts.get(accountId));
  }

  async findAccountByEmail(email: string): Promise<AuthAccountRow | undefined> {
    const normalized = email.trim().toLowerCase();
    return this.clone([...this.accounts.values()].find(account => account.email === normalized));
  }

  async updateAccount(accountId: string, patch: Partial<AuthAccountRow>): Promise<AuthAccountRow> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error('Account not found');
    const updated = { ...account, ...structuredClone(patch), accountId };
    this.accounts.set(accountId, updated);
    return structuredClone(updated);
  }

  async saveSession(row: AuthSessionRow): Promise<void> {
    this.sessions.set(row.sessionId, structuredClone(row));
  }

  async findSession(sessionId: string): Promise<AuthSessionRow | undefined> {
    return this.clone(this.sessions.get(sessionId));
  }

  async updateSession(sessionId: string, patch: Partial<AuthSessionRow>): Promise<AuthSessionRow> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    const updated = { ...session, ...structuredClone(patch), sessionId };
    this.sessions.set(sessionId, updated);
    return structuredClone(updated);
  }

  async rotateSession(row: AuthSessionRow, expectedRotation: number, expectedHash: string): Promise<boolean> {
    const current = this.sessions.get(row.sessionId);
    if (!current || current.revokedAt || current.rotation !== expectedRotation || current.refreshTokenHash !== expectedHash) return false;
    this.sessions.set(row.sessionId, structuredClone(row));
    return true;
  }

  async grantRole(accountId: string, role: PlayerRole): Promise<AuthAccountRow> {
    const account = await this.findAccount(accountId);
    if (!account) throw new Error('Account not found');
    return this.updateAccount(accountId, { roles: [...new Set([...account.roles, role])] });
  }

  async consumeSsoTicket(jti: string): Promise<boolean> {
    if (this.usedTickets.has(jti)) return false;
    this.usedTickets.add(jti);
    return true;
  }

  async upsertAivbAccount(username: string, displayName: string, role: 'student' | 'instructor'): Promise<string> {
    const existing = this.aivbIdentities.get(username);
    const roles: PlayerRole[] = [role];
    if (existing) {
      await this.updateAccount(existing, { displayName, guest: false, roles });
      return existing;
    }
    const accountId = crypto.randomUUID();
    await this.createAccount({ accountId, displayName, guest: false, roles, createdAt: new Date().toISOString() });
    this.aivbIdentities.set(username, accountId);
    return accountId;
  }

  private clone<T>(value: T | undefined): T | undefined {
    return value === undefined ? undefined : structuredClone(value);
  }
}
