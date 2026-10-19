import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CompetitionModule } from '../competition/competition.module.js';
import { ClassroomController } from './classroom.controller.js';
import { ClassroomService } from './classroom.service.js';
import { AnalysisJourneyService } from './analysis-journey.service.js';

@Module({ imports: [AuthModule, CompetitionModule], controllers: [ClassroomController], providers: [ClassroomService, AnalysisJourneyService], exports: [ClassroomService, AnalysisJourneyService] })
export class ClassroomModule {}
