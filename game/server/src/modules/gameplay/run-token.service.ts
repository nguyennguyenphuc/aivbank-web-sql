import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const GAMEPLAY_RUN_SECRET = Symbol('GAMEPLAY_RUN_SECRET');

export interface RunTokenPayload {
  runId: string;
  playerId: string;
  levelId: number;
  contentRevision: string;
  seed: number;
  expiresAt: string;
}

@Injectable()
export class RunTokenService {
  constructor(@Inject(GAMEPLAY_RUN_SECRET) private readonly secret: string) {}

  sign(payload: RunTokenPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encoded}.${this.signature(encoded)}`;
  }

  verify(token: string): RunTokenPayload {
    const [encoded, signature, extra] = token.split('.');
    if (!encoded || !signature || extra) throw new UnauthorizedException('Invalid run token');
    const expected = Buffer.from(this.signature(encoded));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new UnauthorizedException('Invalid run token');
    let payload: RunTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as RunTokenPayload;
    } catch {
      throw new UnauthorizedException('Invalid run token payload');
    }
    if (Date.parse(payload.expiresAt) <= Date.now()) throw new UnauthorizedException('Run token expired');
    return payload;
  }

  private signature(encoded: string): string {
    return createHmac('sha256', this.secret).update(encoded).digest('base64url');
  }
}
