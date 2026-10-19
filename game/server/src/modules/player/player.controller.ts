import { Body, Controller, Get, Inject, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { OriginCsrfGuard } from '../../common/auth/origin-csrf.guard.js';
import type { AuthenticatedRequest } from '../../common/auth/request-auth.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { PlayerService } from './player.service.js';
import type { PlayerProgress, PlayerSettings, PracticeResult } from './player.types.js';

@Controller('/v1/player')
@UseGuards(SessionAuthGuard)
export class PlayerController {
  constructor(@Inject(PlayerService) private readonly playerService: PlayerService) {}

  @Get('/snapshot')
  restore(@Req() request: AuthenticatedRequest) {
    return this.playerService.restore(request.auth.accountId);
  }

  @Patch('/settings')
  @UseGuards(OriginCsrfGuard)
  updateSettings(@Req() request: AuthenticatedRequest, @Body() body: Partial<PlayerSettings>) {
    return this.playerService.updateSettings(request.auth.accountId, body);
  }

  @Post('/progress')
  @UseGuards(OriginCsrfGuard)
  commitProgress(@Req() request: AuthenticatedRequest, @Body() body: Omit<PlayerProgress, 'revision'> & { expectedRevision: number }) {
    return this.playerService.commitProgress(request.auth.accountId, body);
  }

  @Post('/practice-sync')
  @UseGuards(OriginCsrfGuard)
  syncPractice(@Req() request: AuthenticatedRequest, @Body() body: { results: PracticeResult[] }) {
    return this.playerService.syncPractice(request.auth.accountId, body.results ?? []);
  }

  @Post('/settings/reset')
  @UseGuards(OriginCsrfGuard)
  resetSettings(@Req() request: AuthenticatedRequest) {
    return this.playerService.resetSettings(request.auth.accountId);
  }
}
