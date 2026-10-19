import type { ShopProduct } from './commerce.types.js';

export const SHOP_PRODUCTS: readonly ShopProduct[] = [
  { productId: 'coins-1000', priceCurrency: 'USD', price: 199, grants: [{ currency: 'soft', amount: 1000 }] },
  { productId: 'gems-50', priceCurrency: 'USD', price: 499, grants: [{ currency: 'hard', amount: 50 }] },
  { productId: 'booster-bundle', priceCurrency: 'soft', price: 500, grants: [
    { itemId: 'rainbow-booster', quantity: 1 },
    { itemId: 'hammer-booster', quantity: 2 },
  ] },
  { productId: 'hammer-2', priceCurrency: 'soft', price: 100, grants: [{ itemId: 'hammer', quantity: 2 }] },
  { productId: 'lightning-2', priceCurrency: 'soft', price: 120, grants: [{ itemId: 'lightning', quantity: 2 }] },
  { productId: 'shuffle-3', priceCurrency: 'soft', price: 80, grants: [{ itemId: 'shuffle', quantity: 3 }] },
  { productId: 'extra-moves-2', priceCurrency: 'soft', price: 100, grants: [{ itemId: 'extraMoves', quantity: 2 }] },
] as const;

export function findProduct(productId: string): ShopProduct | undefined {
  return SHOP_PRODUCTS.find(product => product.productId === productId);
}
