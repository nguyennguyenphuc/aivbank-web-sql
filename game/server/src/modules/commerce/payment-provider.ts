import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppEnv } from '../../config/env.js';
import { APP_ENV } from '../../database/database.service.js';
import type { ProviderCallback } from './commerce.types.js';

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface PaymentProvider {
  readonly name: string;
  createIntent(intentId: string, productId: string, amountCents: number): Promise<{ checkoutToken: string }>;
  verifyCallback(callback: ProviderCallback): Promise<boolean>;
}

@Injectable()
export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = 'sandbox-payment';
  private readonly secret: string;

  constructor(@Inject(APP_ENV) env: AppEnv) {
    this.secret = `${env.SESSION_SECRET ?? 'local-test-session-secret'}:payments`;
  }

  async createIntent(intentId: string, productId: string, amountCents: number): Promise<{ checkoutToken: string }> {
    return { checkoutToken: this.sign(`${intentId}:${productId}:${amountCents}`) };
  }

  async verifyCallback(callback: ProviderCallback): Promise<boolean> {
    const expected = Buffer.from(this.sign(`${callback.intentId}:${callback.providerEventId}:${callback.status}`));
    const actual = Buffer.from(callback.signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  signCallback(callback: Omit<ProviderCallback, 'signature'>): string {
    return this.sign(`${callback.intentId}:${callback.providerEventId}:${callback.status}`);
  }

  private sign(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }
}
