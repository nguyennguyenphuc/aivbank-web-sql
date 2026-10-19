import { Body, Controller, Get, Headers, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { OriginCsrfGuard } from '../../common/auth/origin-csrf.guard.js';
import type { AuthenticatedRequest } from '../../common/auth/request-auth.js';
import { RequireRoles, RoleGuard } from '../../common/auth/role.guard.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { CommerceService } from './commerce.service.js';
import type { ProviderCallback } from './commerce.types.js';

@Controller('/v1/commerce')
export class CommerceController {
  constructor(@Inject(CommerceService) private readonly commerce: CommerceService) {}

  @Get('/products')
  products() { return this.commerce.products(); }

  @Post('/buy')
  @UseGuards(SessionAuthGuard, OriginCsrfGuard)
  buy(@Req() request: AuthenticatedRequest, @Body() body: { productId: string }, @Headers('idempotency-key') key = '') {
    return this.commerce.buy(request.auth.accountId, body.productId, key);
  }

  @Post('/payment-intents')
  @UseGuards(SessionAuthGuard, OriginCsrfGuard)
  createIntent(@Req() request: AuthenticatedRequest, @Body() body: { productId: string }) {
    return this.commerce.createPaymentIntent(request.auth.accountId, body.productId);
  }

  @Post('/callbacks/sandbox-payment')
  callback(@Body() body: ProviderCallback) { return this.commerce.settleCallback(body); }

  @Post('/refunds')
  @RequireRoles('admin')
  @UseGuards(SessionAuthGuard, RoleGuard, OriginCsrfGuard)
  refund(@Body() body: { intentId: string }, @Headers('idempotency-key') key = '') {
    return this.commerce.refund(body.intentId, key);
  }
}
