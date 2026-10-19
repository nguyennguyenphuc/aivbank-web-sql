import { Module } from '@nestjs/common';
import type { AppEnv } from '../../config/env.js';
import { DatabaseModule } from '../../database/database.module.js';
import { APP_ENV, DatabaseService } from '../../database/database.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { LiveOpsController } from './liveops.controller.js';
import { InMemoryLiveOpsRepository, LIVEOPS_REPOSITORY } from './liveops.repository.js';
import { LiveOpsService } from './liveops.service.js';
import { PostgresLiveOpsRepository } from './postgres-liveops.repository.js';
import { EconomyModule } from '../economy/economy.module.js';

@Module({
  imports: [AuthModule, DatabaseModule, EconomyModule],
  controllers: [LiveOpsController],
  providers: [
    {
      provide: LIVEOPS_REPOSITORY,
      useFactory: (env: AppEnv, database: DatabaseService) => env.USE_FAKE_INTEGRATIONS === 1 || env.NODE_ENV === 'test'
        ? new InMemoryLiveOpsRepository()
        : new PostgresLiveOpsRepository(database),
      inject: [APP_ENV, DatabaseService],
    },
    LiveOpsService,
  ],
  exports: [LiveOpsService, LIVEOPS_REPOSITORY],
})
export class LiveOpsModule {}
