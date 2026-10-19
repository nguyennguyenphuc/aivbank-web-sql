import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { APP_ENV } from '../../database/database.service.js';
import type { AppEnv } from '../../config/env.js';
import { verifyAivbTicket } from './aivb-sso.js';
import { AUTH_REPOSITORY, type AuthRepository } from './auth.repository.js';
import { SessionSigner } from './session-signer.js';
import type { PlayerRole, SessionBundle, SessionPrincipal } from './auth.types.js';

const ACCESS_TTL_MS = 15 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
    @Inject(SessionSigner) private readonly signer: SessionSigner,
    @Inject(APP_ENV) private readonly env?: AppEnv,
  ) {}

  /** Đăng nhập bằng vé SSO của AIV Bank; tạo/cập nhật tài khoản nếu cần. */
  async aivbSso(ticket: string, deviceId: string): Promise<SessionBundle> {
    if (!this.env?.AIVB_SSO_SECRET) throw new NotFoundException('AIV Bank SSO is not enabled');
    if (!deviceId.trim()) throw new BadRequestException('deviceId is required');
    const claims = verifyAivbTicket(ticket, this.env.AIVB_SSO_SECRET);
    if (!await this.repository.consumeSsoTicket(claims.jti, claims.exp * 1000)) {
      throw new UnauthorizedException('SSO ticket already used');
    }
    const accountId = await this.repository.upsertAivbAccount(claims.sub, claims.name, claims.role);
    return this.issue(accountId, deviceId.trim(), 0);
  }

  async createGuest(deviceId: string, displayName?: string): Promise<SessionBundle> {
    if (!deviceId.trim()) throw new BadRequestException('deviceId is required');
    const accountId = randomUUID();
    await this.repository.createAccount({
      accountId,
      displayName: displayName?.trim() || `Guest ${accountId.slice(0, 6)}`,
      guest: true,
      roles: ['student'],
      createdAt: new Date().toISOString(),
    });
    return this.issue(accountId, deviceId.trim(), 0);
  }

  async upgrade(accountId: string, email: string, password: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(normalized)) throw new BadRequestException('Valid email is required');
    if (password.length < 10) throw new BadRequestException('Password must be at least 10 characters');
    if (await this.repository.findAccountByEmail(normalized)) throw new ConflictException('Email already registered');
    const account = await this.repository.findAccount(accountId);
    if (!account) throw new UnauthorizedException('Account not found');
    await this.repository.updateAccount(accountId, {
      email: normalized,
      passwordHash: this.passwordHash(password),
      guest: false,
    });
  }

  async login(email: string, password: string, deviceId: string): Promise<SessionBundle> {
    const account = await this.repository.findAccountByEmail(email.trim().toLowerCase());
    if (!account?.passwordHash || !this.verifyPassword(password, account.passwordHash)) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!deviceId.trim()) throw new BadRequestException('deviceId is required');
    return this.issue(account.accountId, deviceId.trim(), 0);
  }

  async rotate(refreshToken: string): Promise<SessionBundle> {
    const payload = this.signer.verify(refreshToken, 'refresh');
    const session = await this.repository.findSession(payload.sid);
    if (!session || session.revokedAt || session.expiresAt <= Date.now()) {
      throw new UnauthorizedException('Session is not active');
    }
    const supplied = Buffer.from(this.signer.hash(refreshToken));
    const stored = Buffer.from(session.refreshTokenHash);
    if (payload.rot !== session.rotation || supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) {
      await this.repository.updateSession(session.sessionId, { revokedAt: Date.now() });
      throw new UnauthorizedException('Refresh token replay detected');
    }
    return this.issue(session.accountId, session.deviceId, session.rotation + 1, session.sessionId, {
      expectedRotation: session.rotation,
      expectedHash: session.refreshTokenHash,
    });
  }

  async authenticate(accessToken: string): Promise<SessionPrincipal> {
    const payload = this.signer.verify(accessToken, 'access');
    const [session, account] = await Promise.all([
      this.repository.findSession(payload.sid),
      this.repository.findAccount(payload.sub),
    ]);
    if (!session || session.revokedAt || session.expiresAt <= Date.now() || !account) {
      throw new UnauthorizedException('Session is not active');
    }
    return {
      accountId: account.accountId,
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      roles: account.roles,
      guest: account.guest,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.repository.updateSession(sessionId, { revokedAt: Date.now() });
  }

  async grantRole(accountId: string, role: PlayerRole): Promise<void> {
    if (!(['student', 'instructor', 'analyst', 'admin'] as string[]).includes(role)) throw new BadRequestException('Invalid role');
    await this.repository.grantRole(accountId, role);
  }

  verifyPassword(password: string, encoded: string): boolean {
    const [salt, digest] = encoded.split(':');
    if (!salt || !digest) return false;
    const actual = Buffer.from(scryptSync(password, salt, 32).toString('hex'));
    const expected = Buffer.from(digest);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private async issue(
    accountId: string,
    deviceId: string,
    rotation: number,
    sessionId: string = randomUUID(),
    rotationGuard?: { expectedRotation: number; expectedHash: string },
  ): Promise<SessionBundle> {
    const account = await this.repository.findAccount(accountId);
    if (!account) throw new UnauthorizedException('Account not found');
    const now = Date.now();
    const base = { sub: accountId, sid: sessionId, did: deviceId, rot: rotation, iat: now };
    const accessToken = this.signer.sign({ ...base, typ: 'access', exp: now + ACCESS_TTL_MS });
    const refreshToken = this.signer.sign({ ...base, typ: 'refresh', exp: now + REFRESH_TTL_MS });
    const session = {
      sessionId,
      accountId,
      deviceId,
      refreshTokenHash: this.signer.hash(refreshToken),
      rotation,
      expiresAt: now + REFRESH_TTL_MS,
    };
    if (rotationGuard) {
      const rotated = await this.repository.rotateSession(session, rotationGuard.expectedRotation, rotationGuard.expectedHash);
      if (!rotated) {
        await this.repository.updateSession(sessionId, { revokedAt: Date.now() });
        throw new UnauthorizedException('Refresh token replay detected');
      }
    } else {
      await this.repository.saveSession(session);
    }
    return {
      accessToken,
      refreshToken,
      csrfToken: randomBytes(24).toString('base64url'),
      principal: { accountId, sessionId, deviceId, roles: account.roles, guest: account.guest, issuedAt: now, expiresAt: now + ACCESS_TTL_MS },
    };
  }

  private passwordHash(password: string): string {
    const salt = randomBytes(16).toString('hex');
    return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
  }
}
