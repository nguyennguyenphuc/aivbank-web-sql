import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { CacheService } from './cache/cache.service.js';
import { HealthController } from './health/health.controller.js';
import { HealthService } from './health/health.service.js';
import { AppController } from './app.controller.js';
import { AdsModule } from './modules/ads/ads.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CommerceModule } from './modules/commerce/commerce.module.js';
import { ContentModule } from './modules/content/content.module.js';
import { EconomyModule } from './modules/economy/economy.module.js';
import { GameplayModule } from './modules/gameplay/gameplay.module.js';
import { PlayerModule } from './modules/player/player.module.js';
import { CompetitionModule } from './modules/competition/competition.module.js';
import { LiveOpsModule } from './modules/liveops/liveops.module.js';
import { ExperimentsModule } from './modules/experiments/experiments.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { ClassroomModule } from './modules/classroom/classroom.module.js';
import { ExportsModule } from './modules/exports/exports.module.js';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    PlayerModule,
    EconomyModule,
    CommerceModule,
    AdsModule,
    ContentModule,
    CompetitionModule,
    LiveOpsModule,
    ExperimentsModule,
    AnalyticsModule,
    ClassroomModule,
    ExportsModule,
    GameplayModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    CacheService,
    HealthService,
  ],
})
export class AppModule {}
