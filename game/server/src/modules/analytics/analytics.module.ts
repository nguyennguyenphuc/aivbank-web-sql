import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { LiveProjectionModule } from '../live-projection/live-projection.module.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';

@Module({ imports: [AuthModule, LiveProjectionModule], controllers: [AnalyticsController], providers: [AnalyticsService], exports: [AnalyticsService] })
export class AnalyticsModule {}
