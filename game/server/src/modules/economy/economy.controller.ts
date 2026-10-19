import { Body, Controller, Get, Headers, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { OriginCsrfGuard } from '../../common/auth/origin-csrf.guard.js';
import type { AuthenticatedRequest } from '../../common/auth/request-auth.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { EconomyService } from './economy.service.js';
import { RewardService } from './reward.service.js';

type BoosterType = 'hammer' | 'shuffle' | 'lightning' | 'extraMoves';

@Controller('/v1/economy')
@UseGuards(SessionAuthGuard)
export class EconomyController {
  constructor(
    @Inject(EconomyService) private readonly economy: EconomyService,
    @Inject(RewardService) private readonly rewards: RewardService,
  ) {}

  @Get('/wallet')
  wallet(@Req() request: AuthenticatedRequest) {
    return this.economy.wallet(request.auth.accountId);
  }

  @Post('/bootstrap')
  @UseGuards(OriginCsrfGuard)
  bootstrap(@Req() request: AuthenticatedRequest) {
    return this.rewards.starterPack(request.auth.accountId);
  }

  @Post('/daily-spin')
  @UseGuards(OriginCsrfGuard)
  dailySpin(@Req() request: AuthenticatedRequest, @Body() body: { day: string }, @Headers('idempotency-key') key = '') {
    return this.rewards.dailySpin(request.auth.accountId, body.day, key);
  }

  @Get('/daily-gift')
  dailyGiftStatus(@Req() request: AuthenticatedRequest) {
    return this.rewards.dailyGiftStatus(request.auth.accountId);
  }

  @Post('/daily-gift')
  @UseGuards(OriginCsrfGuard)
  dailyGift(@Req() request: AuthenticatedRequest, @Body() body: { day: string }, @Headers('idempotency-key') key = '') {
    return this.rewards.dailyGift(request.auth.accountId, body.day, key);
  }

  @Post('/extra-moves')
  @UseGuards(OriginCsrfGuard)
  extraMoves(@Req() request: AuthenticatedRequest, @Body() body: { attemptId: string }, @Headers('idempotency-key') key = '') {
    return this.rewards.buyExtraMoves(request.auth.accountId, body.attemptId, key);
  }

  @Post('/use-booster')
  @UseGuards(OriginCsrfGuard)
  useBooster(@Req() request: AuthenticatedRequest, @Body() body: { boosterType: BoosterType; referenceId: string }, @Headers('idempotency-key') key = '') {
    return this.economy.useBooster(request.auth.accountId, body.boosterType, body.referenceId, key);
  }
}
