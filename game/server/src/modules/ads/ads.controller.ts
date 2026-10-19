import { Body, Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { OriginCsrfGuard } from '../../common/auth/origin-csrf.guard.js';
import type { AuthenticatedRequest } from '../../common/auth/request-auth.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import type { AdCallback } from './ad-provider.js';
import { AdsService } from './ads.service.js';

@Controller('/v1/ads')
export class AdsController {
  constructor(@Inject(AdsService) private readonly ads: AdsService) {}

  @Post('/reward-tokens')
  @UseGuards(SessionAuthGuard, OriginCsrfGuard)
  issue(@Req() request: AuthenticatedRequest, @Body() body: { placement: string }) {
    return this.ads.issue(request.auth.accountId, body.placement);
  }

  @Post('/callbacks/sandbox-ad')
  callback(@Body() body: AdCallback) { return this.ads.callback(body); }
}
