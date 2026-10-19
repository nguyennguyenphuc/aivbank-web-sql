import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { LeaderboardScope } from '../../../../shared/contracts/competition/index.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { OriginCsrfGuard } from '../../common/auth/origin-csrf.guard.js';
import { RequireRoles, RoleGuard } from '../../common/auth/role.guard.js';
import type { AuthenticatedRequest } from '../../common/auth/request-auth.js';
import { CompetitionMetaService } from './competition-meta.service.js';
import { CompetitionService } from './competition.service.js';

@Controller('/v1/competition')
@UseGuards(SessionAuthGuard)
export class CompetitionController {
  constructor(
    @Inject(CompetitionService) private readonly competition: CompetitionService,
    @Inject(CompetitionMetaService) private readonly meta: CompetitionMetaService,
  ) {}

  @Get('/leaderboards')
  top(@Req() request: AuthenticatedRequest, @Query() query: Record<string, string | undefined>) {
    return this.competition.top(parseScope(query), request.auth.accountId, Number(query.limit ?? 50));
  }

  @Get('/leaderboards/around-me')
  around(@Req() request: AuthenticatedRequest, @Query() query: Record<string, string | undefined>) {
    return this.competition.around(parseScope(query), request.auth.accountId, Number(query.radius ?? 2));
  }

  @Get('/meta')
  state(@Req() request: AuthenticatedRequest) {
    return this.meta.get(request.auth.accountId);
  }

  @Post('/classrooms/:classroomId/rosters/:rosterRevision')
  @UseGuards(OriginCsrfGuard, RoleGuard)
  @RequireRoles('admin')
  registerRoster(
    @Param('classroomId') classroomId: string,
    @Param('rosterRevision') rosterRevision: string,
    @Body() body: { playerIds?: string[] },
  ) {
    return this.competition.registerRoster(classroomId, rosterRevision, body.playerIds ?? []);
  }
}

function parseScope(query: Record<string, string | undefined>): LeaderboardScope {
  if (query.scope === 'country') return { kind: 'country', countryCode: query.countryCode ?? '' };
  if (query.scope === 'season') return { kind: 'season', seasonId: query.seasonId ?? '' };
  if (query.scope === 'classroom') {
    return { kind: 'classroom', classroomId: query.classroomId ?? '', rosterRevision: query.rosterRevision ?? '' };
  }
  return { kind: 'global' };
}
