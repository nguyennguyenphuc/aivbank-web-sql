import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { InboxMessage, LiveOpsCalendar } from '../../../../shared/contracts/liveops/index.js';
import { OriginCsrfGuard } from '../../common/auth/origin-csrf.guard.js';
import type { AuthenticatedRequest } from '../../common/auth/request-auth.js';
import { RequireRoles, RoleGuard } from '../../common/auth/role.guard.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { LiveOpsService } from './liveops.service.js';

@Controller('/v1/liveops')
@UseGuards(SessionAuthGuard)
export class LiveOpsController {
  constructor(@Inject(LiveOpsService) private readonly liveops: LiveOpsService) {}

  @Get('/hub')
  hub(@Req() request: AuthenticatedRequest) {
    return this.liveops.hub(request.auth.accountId);
  }

  @Post('/quests/:questId/claim')
  @UseGuards(OriginCsrfGuard)
  claimQuest(@Req() request: AuthenticatedRequest, @Param('questId') questId: string) {
    return this.liveops.claimQuest(request.auth.accountId, questId);
  }

  @Post('/inbox/:messageId/claim')
  @UseGuards(OriginCsrfGuard)
  claimInbox(@Req() request: AuthenticatedRequest, @Param('messageId') messageId: string) {
    return this.liveops.claimInbox(request.auth.accountId, messageId);
  }

  @Post('/calendar')
  @UseGuards(OriginCsrfGuard, RoleGuard)
  @RequireRoles('admin')
  publishCalendar(@Body() body: { calendar: LiveOpsCalendar; expectedActiveRevision?: string }) {
    return this.liveops.publishCalendar(body.calendar, body.expectedActiveRevision);
  }

  @Post('/inbox')
  @UseGuards(OriginCsrfGuard, RoleGuard)
  @RequireRoles('admin')
  publishInbox(@Body() body: InboxMessage) {
    return this.liveops.publishInbox(body);
  }
}
