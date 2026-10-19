import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { ExperimentDefinition, RemoteConfigRevision } from '../../../../shared/contracts/experiments/index.js';
import { OriginCsrfGuard } from '../../common/auth/origin-csrf.guard.js';
import type { AuthenticatedRequest } from '../../common/auth/request-auth.js';
import { RequireRoles, RoleGuard } from '../../common/auth/role.guard.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { ExperimentService } from './experiment.service.js';
import { RemoteConfigService } from './remote-config.service.js';

@Controller('/v1/experiments')
@UseGuards(SessionAuthGuard)
export class ExperimentsController {
  constructor(
    @Inject(RemoteConfigService) private readonly config: RemoteConfigService,
    @Inject(ExperimentService) private readonly experiments: ExperimentService,
  ) {}

  @Get('/remote-config')
  resolve(@Query() query: Record<string, string | undefined>) {
    return this.config.resolve(query.appVersion ?? '0.0.0', query.knownRevision);
  }

  @Get('/assignment')
  async assignment(@Req() request: AuthenticatedRequest, @Query() query: Record<string, string | undefined>) {
    const config = await this.config.current();
    return this.experiments.assign({
      experimentId: query.experimentId ?? '', revision: query.revision ?? '', subjectId: request.auth.accountId,
      countryCode: query.countryCode, experimentsKilled: config.killSwitches.experiments,
    });
  }

  @Post('/remote-config')
  @UseGuards(OriginCsrfGuard, RoleGuard)
  @RequireRoles('admin')
  publishConfig(@Body() body: { config: RemoteConfigRevision; expectedActiveRevision?: string }) {
    return this.config.publish(body.config, body.expectedActiveRevision);
  }

  @Post('/remote-config/rollback')
  @UseGuards(OriginCsrfGuard, RoleGuard)
  @RequireRoles('admin')
  rollback(@Body() body: { targetRevision: string; newRevision: string; expectedActiveRevision: string }) {
    return this.config.rollback(body.targetRevision, body.newRevision, body.expectedActiveRevision);
  }

  @Post('/definitions')
  @UseGuards(OriginCsrfGuard, RoleGuard)
  @RequireRoles('admin')
  publishExperiment(@Body() body: ExperimentDefinition) {
    return this.experiments.publish(body);
  }
}
