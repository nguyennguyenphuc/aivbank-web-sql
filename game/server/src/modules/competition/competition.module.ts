import { Module } from '@nestjs/common';
import { CacheModule } from '../../cache/cache.module.js';
import { CacheService } from '../../cache/cache.service.js';
import type { AppEnv } from '../../config/env.js';
import { DatabaseModule } from '../../database/database.module.js';
import { APP_ENV, DatabaseService } from '../../database/database.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { CompetitionController } from './competition.controller.js';
import { COMPETITION_META_REPOSITORY, InMemoryCompetitionMetaRepository } from './competition-meta.repository.js';
import { CompetitionMetaService } from './competition-meta.service.js';
import { COMPETITION_REPOSITORY, InMemoryCompetitionRepository } from './competition.repository.js';
import { CompetitionService } from './competition.service.js';
import { CacheServiceLeaderboardCache, InMemoryLeaderboardCache, LEADERBOARD_CACHE } from './leaderboard-cache.js';
import { PostgresCompetitionMetaRepository } from './postgres-competition-meta.repository.js';
import { PostgresCompetitionRepository } from './postgres-competition.repository.js';

@Module({
  imports: [AuthModule, DatabaseModule, CacheModule],
  controllers: [CompetitionController],
  providers: [
    {
      provide: COMPETITION_REPOSITORY,
      useFactory: (env: AppEnv, database: DatabaseService) => env.USE_FAKE_INTEGRATIONS === 1 || env.NODE_ENV === 'test'
        ? new InMemoryCompetitionRepository()
        : new PostgresCompetitionRepository(database),
      inject: [APP_ENV, DatabaseService],
    },
    {
      provide: COMPETITION_META_REPOSITORY,
      useFactory: (env: AppEnv, database: DatabaseService) => env.USE_FAKE_INTEGRATIONS === 1 || env.NODE_ENV === 'test'
        ? new InMemoryCompetitionMetaRepository()
        : new PostgresCompetitionMetaRepository(database),
      inject: [APP_ENV, DatabaseService],
    },
    {
      provide: LEADERBOARD_CACHE,
      useFactory: (env: AppEnv, cache: CacheService) => env.USE_FAKE_INTEGRATIONS === 1 || env.NODE_ENV === 'test'
        ? new InMemoryLeaderboardCache()
        : new CacheServiceLeaderboardCache(cache),
      inject: [APP_ENV, CacheService],
    },
    CompetitionService,
    CompetitionMetaService,
  ],
  exports: [
    CompetitionService,
    CompetitionMetaService,
    COMPETITION_REPOSITORY,
    COMPETITION_META_REPOSITORY,
    LEADERBOARD_CACHE,
  ],
})
export class CompetitionModule {}
