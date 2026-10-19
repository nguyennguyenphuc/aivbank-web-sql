import { Body, ConflictException, Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type { TelemetryIngestEvent } from '../../../../shared/contracts/telemetry/index.js';
import type { AuthenticatedRequest } from '../../common/auth/request-auth.js';
import { OriginCsrfGuard } from '../../common/auth/origin-csrf.guard.js';
import { RequireRoles, RoleGuard } from '../../common/auth/role.guard.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { AnalyticsService } from './analytics.service.js';

@Controller('/v1/analytics')
@UseGuards(SessionAuthGuard)
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analytics: AnalyticsService) {}

  @Post('/events')
  @UseGuards(OriginCsrfGuard)
  ingest(@Req() request: AuthenticatedRequest, @Body() body: TelemetryIngestEvent) {
    if (body?.eventName === 'game_observation' && request.headers['x-telemetry-account-id'] !== request.auth.accountId) {
      throw new ConflictException('Telemetry account does not match authenticated session');
    }
    return this.analytics.ingest(request.auth.accountId, body, {
      userAgent: request.headers['user-agent'],
      acceptLanguage: request.headers['accept-language'],
    });
  }

  @Get('/teaching-snapshot')
  @UseGuards(RoleGuard)
  @RequireRoles('instructor', 'analyst', 'admin')
  snapshot() { return this.analytics.teachingSnapshot(); }
}
