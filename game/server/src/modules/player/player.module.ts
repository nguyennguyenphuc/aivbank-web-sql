import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PlayerController } from './player.controller.js';
import { InMemoryPlayerRepository, PLAYER_REPOSITORY } from './player.repository.js';
import { PlayerService } from './player.service.js';
import { PostgresPlayerRepository } from './postgres-player.repository.js';
import { APP_ENV, DatabaseService } from '../../database/database.service.js';
import type { AppEnv } from '../../config/env.js';

@Module({
  imports: [AuthModule],
  controllers: [PlayerController],
  providers: [
    {
      provide: PLAYER_REPOSITORY,
      useFactory: (env: AppEnv, database: DatabaseService) => env.USE_FAKE_INTEGRATIONS === 1 || env.NODE_ENV === 'test'
        ? new InMemoryPlayerRepository()
        : new PostgresPlayerRepository(database),
      inject: [APP_ENV, DatabaseService],
    },
    PlayerService,
  ],
  exports: [PlayerService, PLAYER_REPOSITORY],
})
export class PlayerModule {}
