import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { OriginCsrfGuard } from '../../common/auth/origin-csrf.guard.js';
import { RequireRoles, RoleGuard } from '../../common/auth/role.guard.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import type { AuthenticatedRequest } from '../../common/auth/request-auth.js';
import { GameplayService } from './gameplay.service.js';

@Controller('/gameplay')
@UseGuards(SessionAuthGuard)
export class GameplayController {
  constructor(@Inject(GameplayService) private readonly gameplay: GameplayService) {}

  @Post('/runs/start')
  @UseGuards(OriginCsrfGuard)
  start(@Req() request: AuthenticatedRequest, @Body() body: Parameters<GameplayService['start']>[0]): unknown {
    return this.gameplay.start({ ...body, playerId: request.auth.accountId });
  }

  @Post('/runs/submit')
  @UseGuards(OriginCsrfGuard)
  submit(@Req() request: AuthenticatedRequest, @Body() body: Parameters<GameplayService['submit']>[0]): unknown {
    return this.gameplay.submit(body, request.auth.accountId);
  }

  @Get('/runs/:runId/suspicious-replay')
  @UseGuards(RoleGuard)
  @RequireRoles('analyst', 'admin')
  capture(@Param('runId') runId: string): unknown {
    return this.gameplay.getCapture(runId);
  }
}
