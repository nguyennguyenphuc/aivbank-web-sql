import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { EconomyService } from '../economy/economy.service.js';
import { LiveProjectionService } from '../live-projection/live-projection.service.js';
import type { WalletSnapshot } from '../economy/economy.types.js';
import { COMMERCE_REPOSITORY, type CommerceRepository } from './commerce.repository.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider.js';
import { findProduct, SHOP_PRODUCTS } from './product-catalog.js';
import type { ProviderCallback, PurchaseReceiptRow, ShopProduct } from './commerce.types.js';

@Injectable()
export class CommerceService {
  private readonly callbackTails = new Map<string, Promise<void>>();

  constructor(
    @Inject(COMMERCE_REPOSITORY) private readonly repository: CommerceRepository,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(EconomyService) private readonly economy: EconomyService,
    @Optional() @Inject(LiveProjectionService) private readonly projection?: LiveProjectionService,
  ) {}

  products(): readonly ShopProduct[] { return SHOP_PRODUCTS; }

  async buy(accountId: string, productId: string, idempotencyKey: string): Promise<WalletSnapshot> {
    const product = this.product(productId);
    if (product.priceCurrency === 'USD') throw new BadRequestException('Cash product requires a payment intent');
    const wallet = await this.economy.spend(accountId, product.priceCurrency, product.price, 'shop-purchase', productId, idempotencyKey, product.grants);
    await this.projection?.purchase(accountId, { key: idempotencyKey, productId, priceCents: product.price, currency: product.priceCurrency });
    return wallet;
  }

  async createPaymentIntent(accountId: string, productId: string): Promise<{ intentId: string; provider: string; checkoutToken: string }> {
    const product = this.product(productId);
    if (product.priceCurrency !== 'USD') throw new BadRequestException('Product does not use cash payment');
    const intentId = randomUUID();
    await this.repository.saveIntent({ intentId, accountId, productId, provider: this.provider.name, status: 'pending', createdAt: new Date().toISOString() });
    const external = await this.provider.createIntent(intentId, productId, product.price);
    return { intentId, provider: this.provider.name, ...external };
  }

  async settleCallback(callback: ProviderCallback): Promise<PurchaseReceiptRow> {
    if (!await this.provider.verifyCallback(callback)) throw new UnauthorizedException('Invalid provider callback signature');
    return this.withCallbackLock(callback.intentId, () => this.settleVerifiedCallback(callback));
  }

  private async settleVerifiedCallback(callback: ProviderCallback): Promise<PurchaseReceiptRow> {
    const duplicateEvent = await this.repository.receiptByEvent(callback.providerEventId);
    if (duplicateEvent) return duplicateEvent;
    const intent = await this.repository.intent(callback.intentId);
    if (!intent) throw new BadRequestException('Payment intent not found');
    const existing = await this.repository.receiptByIntent(intent.intentId);
    if (existing) {
      if (intent.status !== existing.status) await this.repository.updateIntent(intent.intentId, existing.status);
      return existing;
    }
    if (callback.status !== 'paid') throw new BadRequestException('Payment was not completed');
    const product = this.product(intent.productId);
    const ledgerKey = `payment:${intent.intentId}`;
    const wallet = await this.economy.grant(intent.accountId, product.grants, 'payment', intent.intentId, ledgerKey, `purchase:${intent.intentId}`);
    const journal = await this.economy.journalByKey(intent.accountId, ledgerKey);
    if (!journal) throw new Error('Payment journal was not recorded');
    const receipt = { receiptId: randomUUID(), intentId: intent.intentId, providerEventId: callback.providerEventId, journalId: journal.journalId, status: 'settled' as const, wallet };
    await this.repository.saveReceipt(receipt);
    await this.repository.updateIntent(intent.intentId, 'settled');
    await this.projection?.purchase(intent.accountId, { key: intent.intentId, productId: product.productId, priceCents: product.price, currency: 'USD' });
    return (await this.repository.receiptByIntent(intent.intentId)) ?? receipt;
  }

  async refund(intentId: string, idempotencyKey: string): Promise<PurchaseReceiptRow> {
    const intent = await this.repository.intent(intentId);
    const receipt = await this.repository.receiptByIntent(intentId);
    if (!intent || !receipt) throw new BadRequestException('Settled purchase not found');
    if (receipt.status === 'refunded') return receipt;
    const wallet = await this.economy.reverse(intent.accountId, receipt.journalId, idempotencyKey);
    const refunded = { ...receipt, status: 'refunded' as const, wallet };
    await this.repository.saveReceipt(refunded);
    await this.repository.updateIntent(intentId, 'refunded');
    const product = findProduct(intent.productId);
    if (product) await this.projection?.purchase(intent.accountId, { key: intentId, productId: product.productId, priceCents: product.price, currency: 'USD', refund: true });
    return refunded;
  }

  private product(productId: string): ShopProduct {
    const product = findProduct(productId);
    if (!product) throw new ConflictException('Product is unavailable');
    return product;
  }

  private async withCallbackLock<T>(intentId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.callbackTails.get(intentId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = prior.then(() => current);
    this.callbackTails.set(intentId, tail);
    await prior;
    try { return await operation(); } finally {
      release();
      if (this.callbackTails.get(intentId) === tail) this.callbackTails.delete(intentId);
    }
  }
}
