import { Module } from '@nestjs/common';
import { APP_ENV, DatabaseService } from '../../database/database.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { EconomyModule } from '../economy/economy.module.js';
import { LiveProjectionModule } from '../live-projection/live-projection.module.js';
import { AD_PROVIDER, SandboxAdProvider } from './ad-provider.js';
import { AdsController } from './ads.controller.js';
import { ADS_REPOSITORY, InMemoryAdsRepository } from './ads.repository.js';
import { AdsService } from './ads.service.js';
import { PostgresAdsRepository } from './postgres-ads.repository.js';
import type { AppEnv } from '../../config/env.js';

@Module({
  imports: [AuthModule, EconomyModule, LiveProjectionModule],
  controllers: [AdsController],
  providers: [
    {
      provide: ADS_REPOSITORY,
      useFactory: (env: AppEnv, database: DatabaseService) => env.USE_FAKE_INTEGRATIONS === 1 || env.NODE_ENV === 'test'
        ? new InMemoryAdsRepository()
        : new PostgresAdsRepository(database),
      inject: [APP_ENV, DatabaseService],
    },
    { provide: AD_PROVIDER, useClass: SandboxAdProvider },
    AdsService,
  ],
  exports: [AdsService, ADS_REPOSITORY, AD_PROVIDER],
})
export class AdsModule {}
