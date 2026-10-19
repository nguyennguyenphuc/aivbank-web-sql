import { Module } from '@nestjs/common';
import { APP_ENV, DatabaseService } from '../../database/database.service.js';
import { OriginCsrfGuard } from '../../common/auth/origin-csrf.guard.js';
import { RoleGuard } from '../../common/auth/role.guard.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { AuthController } from './auth.controller.js';
import { AUTH_REPOSITORY, InMemoryAuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';
import { SessionSigner } from './session-signer.js';
import { PostgresAuthRepository } from './postgres-auth.repository.js';
import type { AppEnv } from '../../config/env.js';

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: AUTH_REPOSITORY,
      useFactory: (env: AppEnv, database: DatabaseService) => env.USE_FAKE_INTEGRATIONS === 1 || env.NODE_ENV === 'test'
        ? new InMemoryAuthRepository()
        : new PostgresAuthRepository(database),
      inject: [APP_ENV, DatabaseService],
    },
    SessionSigner,
    AuthService,
    SessionAuthGuard,
    OriginCsrfGuard,
    RoleGuard,
  ],
  exports: [AuthService, SessionAuthGuard, OriginCsrfGuard, RoleGuard, AUTH_REPOSITORY],
})
export class AuthModule {}
