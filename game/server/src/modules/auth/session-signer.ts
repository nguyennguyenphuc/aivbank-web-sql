import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { APP_ENV } from '../../database/database.service.js';
import type { AppEnv } from '../../config/env.js';

interface SignedPayload {
  typ: 'access' | 'refresh';
  sub: string;
  sid: string;
  did: string;
  rot: number;
  iat: number;
  exp: number;
}

@Injectable()
export class SessionSigner {
  private readonly secret: string;

  constructor(@Inject(APP_ENV) env: AppEnv) {
    this.secret = env.SESSION_SECRET ?? (env.NODE_ENV === 'production' ? '' : 'local-test-session-secret');
    if (this.secret.length < 16) throw new Error('SESSION_SECRET must contain at least 16 characters');
  }

  sign(payload: SignedPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  verify(token: string, expectedType: SignedPayload['typ']): SignedPayload {
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra || !this.validMac(body, signature)) {
      throw new UnauthorizedException('Invalid session signature');
    }
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedPayload;
      if (payload.typ !== expectedType || payload.exp <= Date.now()) throw new Error('expired');
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired session');
    }
  }

  hash(token: string): string {
    return this.mac(`refresh:${token}`);
  }

  private mac(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }

  private validMac(body: string, signature: string): boolean {
    const expected = Buffer.from(this.mac(body));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
