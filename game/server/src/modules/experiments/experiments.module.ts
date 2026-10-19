import { Module } from '@nestjs/common';
import type { AppEnv } from '../../config/env.js';
import { DatabaseModule } from '../../database/database.module.js';
import { APP_ENV, DatabaseService } from '../../database/database.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { EXPERIMENT_REPOSITORY, InMemoryExperimentRepository } from './experiment.repository.js';
import { ExperimentService } from './experiment.service.js';
import { ExperimentsController } from './experiments.controller.js';
import { PostgresExperimentRepository } from './postgres-experiment.repository.js';
import { PostgresRemoteConfigRepository } from './postgres-remote-config.repository.js';
import { InMemoryRemoteConfigRepository, REMOTE_CONFIG_REPOSITORY } from './remote-config.repository.js';
import { RemoteConfigService } from './remote-config.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [ExperimentsController],
  providers: [
    {
      provide: REMOTE_CONFIG_REPOSITORY,
      useFactory: (env: AppEnv, database: DatabaseService) => env.USE_FAKE_INTEGRATIONS === 1 || env.NODE_ENV === 'test'
        ? new InMemoryRemoteConfigRepository()
        : new PostgresRemoteConfigRepository(database),
      inject: [APP_ENV, DatabaseService],
    },
    {
      provide: EXPERIMENT_REPOSITORY,
      useFactory: (env: AppEnv, database: DatabaseService) => env.USE_FAKE_INTEGRATIONS === 1 || env.NODE_ENV === 'test'
        ? new InMemoryExperimentRepository()
        : new PostgresExperimentRepository(database),
      inject: [APP_ENV, DatabaseService],
    },
    RemoteConfigService,
    ExperimentService,
  ],
  exports: [RemoteConfigService, ExperimentService, REMOTE_CONFIG_REPOSITORY, EXPERIMENT_REPOSITORY],
})
export class ExperimentsModule {}
