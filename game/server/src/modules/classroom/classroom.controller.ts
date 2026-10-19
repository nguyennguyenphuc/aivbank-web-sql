import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthenticatedRequest } from '../../common/auth/request-auth.js';
import { OriginCsrfGuard } from '../../common/auth/origin-csrf.guard.js';
import { RequireRoles, RoleGuard } from '../../common/auth/role.guard.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import type { SaveAnalysisStepRequest } from '../../../../shared/contracts/classroom/index.js';
import { AnalysisJourneyService } from './analysis-journey.service.js';
import { ClassroomService } from './classroom.service.js';

@Controller('/v1/classrooms')
@UseGuards(SessionAuthGuard)
export class ClassroomController {
  constructor(
    @Inject(ClassroomService) private readonly classrooms: ClassroomService,
    @Inject(AnalysisJourneyService) private readonly journeys: AnalysisJourneyService,
  ) {}

  @Get('/scenarios')
  scenarios() { return this.classrooms.scenarios(); }

  @Get('/mine')
  mine(@Req() request: AuthenticatedRequest) { return this.classrooms.mine(request.auth.accountId); }

  @Get('/assignments/mine')
  assignments(@Req() request: AuthenticatedRequest) { return this.journeys.assignmentsForLearner(request.auth.accountId); }

  @Post('/assignments/:assignmentId/start')
  @UseGuards(OriginCsrfGuard)
  startJourney(@Req() request: AuthenticatedRequest, @Param('assignmentId') assignmentId: string) {
    return this.journeys.start(request.auth.accountId, assignmentId);
  }

  @Get('/assignments/:assignmentId/journey')
  journey(@Req() request: AuthenticatedRequest, @Param('assignmentId') assignmentId: string) {
    return this.journeys.journey(request.auth.accountId, assignmentId);
  }

  @Post('/assignments/:assignmentId/steps/:stepId')
  @UseGuards(OriginCsrfGuard)
  saveStep(@Req() request: AuthenticatedRequest, @Param('assignmentId') assignmentId: string, @Param('stepId') stepId: string, @Body() body: SaveAnalysisStepRequest) {
    return this.journeys.saveStep(request.auth.accountId, assignmentId, stepId, body);
  }

  @Post('/assignments/:assignmentId/submit')
  @UseGuards(OriginCsrfGuard)
  submitJourney(@Req() request: AuthenticatedRequest, @Param('assignmentId') assignmentId: string) {
    return this.journeys.submit(request.auth.accountId, assignmentId);
  }

  @Get('/assignments/:assignmentId/result')
  result(@Req() request: AuthenticatedRequest, @Param('assignmentId') assignmentId: string) {
    return this.journeys.result(request.auth.accountId, assignmentId);
  }

  @Post()
  @UseGuards(OriginCsrfGuard, RoleGuard)
  @RequireRoles('instructor', 'admin')
  create(@Req() request: AuthenticatedRequest, @Body() body: { name?: string }) { return this.classrooms.create(request.auth.accountId, body.name ?? ''); }

  @Post('/join')
  @UseGuards(OriginCsrfGuard)
  join(@Req() request: AuthenticatedRequest, @Body() body: { joinCode?: string }) { return this.classrooms.join(request.auth.accountId, body.joinCode ?? ''); }

  @Post('/:classroomId/assignments')
  @UseGuards(OriginCsrfGuard, RoleGuard)
  @RequireRoles('instructor', 'admin')
  assign(@Req() request: AuthenticatedRequest, @Param('classroomId') classroomId: string, @Body() body: { scenarioId: string; title: string; opensAt: string; closesAt: string }) {
    return this.classrooms.assign(request.auth.accountId, { ...body, classroomId });
  }

  @Get('/:classroomId/assignments')
  @UseGuards(RoleGuard)
  @RequireRoles('instructor', 'admin')
  teacherAssignments(@Req() request: AuthenticatedRequest, @Param('classroomId') classroomId: string) {
    return this.journeys.assignmentsForTeacher(request.auth.accountId, classroomId, request.auth.roles.includes('admin'));
  }

  @Get('/:classroomId/dashboard')
  @UseGuards(RoleGuard)
  @RequireRoles('instructor', 'analyst', 'admin')
  dashboard(@Req() request: AuthenticatedRequest, @Param('classroomId') classroomId: string) {
    return this.classrooms.dashboard(classroomId, request.auth.accountId, request.auth.roles.includes('admin'));
  }

  @Get('/:classroomId/assignments/:assignmentId/progress')
  @UseGuards(RoleGuard)
  @RequireRoles('instructor', 'admin')
  progress(@Req() request: AuthenticatedRequest, @Param('classroomId') classroomId: string, @Param('assignmentId') assignmentId: string) {
    return this.journeys.teacherProgress(request.auth.accountId, classroomId, assignmentId, request.auth.roles.includes('admin'));
  }
}
