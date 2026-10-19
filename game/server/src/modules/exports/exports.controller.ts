import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { RequireRoles, RoleGuard } from '../../common/auth/role.guard.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { ExportsService } from './exports.service.js';

@Controller('/v1/exports')
@UseGuards(SessionAuthGuard, RoleGuard)
@RequireRoles('instructor', 'analyst', 'admin')
export class ExportsController {
  constructor(@Inject(ExportsService) private readonly exportsService: ExportsService) {}
  @Get('/compatibility-status') status() { return this.exportsService.status(); }
}
