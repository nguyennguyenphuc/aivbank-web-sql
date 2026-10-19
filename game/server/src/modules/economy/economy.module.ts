import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EconomyController } from './economy.controller.js';
import { ECONOMY_REPOSITORY, InMemoryEconomyRepository } from './economy.repository.js';
import { EconomyService } from './economy.service.js';
import { RewardService } from './reward.service.js';
import { WalletLockService } from './wallet-lock.service.js';
import { PostgresEconomyRepository } from './postgres-economy.repository.js';
import { APP_ENV, DatabaseService } from '../../database/database.service.js';
import type { AppEnv } from '../../config/env.js';

@Module({
  imports: [AuthModule],
  controllers: [EconomyController],
  providers: [
    {
      provide: ECONOMY_REPOSITORY,
      useFactory: (env: AppEnv, database: DatabaseService) => env.USE_FAKE_INTEGRATIONS === 1 || env.NODE_ENV === 'test'
        ? new InMemoryEconomyRepository()
        : new PostgresEconomyRepository(database),
      inject: [APP_ENV, DatabaseService],
    },
    WalletLockService,
    EconomyService,
    RewardService,
  ],
  exports: [EconomyService, RewardService, ECONOMY_REPOSITORY],
})
export class EconomyModule {}
