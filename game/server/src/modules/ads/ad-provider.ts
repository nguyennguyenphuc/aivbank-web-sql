import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppEnv } from '../../config/env.js';
import { APP_ENV } from '../../database/database.service.js';

export interface AdCallback {
  tokenId: string;
  providerEventId: string;
  status: 'completed' | 'failed';
  signature: string;
}

export const AD_PROVIDER = Symbol('AD_PROVIDER');

export interface AdProvider {
  readonly name: string;
  issue(tokenId: string, placement: string): Promise<{ adToken: string }>;
  verify(callback: AdCallback): Promise<boolean>;
}

@Injectable()
export class SandboxAdProvider implements AdProvider {
  readonly name = 'sandbox-ad';
  private readonly secret: string;

  constructor(@Inject(APP_ENV) env: AppEnv) {
    this.secret = `${env.SESSION_SECRET ?? 'local-test-session-secret'}:ads`;
  }

  async issue(tokenId: string, placement: string): Promise<{ adToken: string }> {
    return { adToken: this.sign(`${tokenId}:${placement}`) };
  }

  async verify(callback: AdCallback): Promise<boolean> {
    const expected = Buffer.from(this.sign(`${callback.tokenId}:${callback.providerEventId}:${callback.status}`));
    const actual = Buffer.from(callback.signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  signCallback(callback: Omit<AdCallback, 'signature'>): string {
    return this.sign(`${callback.tokenId}:${callback.providerEventId}:${callback.status}`);
  }

  private sign(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }
}
