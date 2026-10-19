import { Module } from '@nestjs/common';
import { APP_ENV, DatabaseService } from '../../database/database.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { EconomyModule } from '../economy/economy.module.js';
import { LiveProjectionModule } from '../live-projection/live-projection.module.js';
import { CommerceController } from './commerce.controller.js';
import { COMMERCE_REPOSITORY, InMemoryCommerceRepository } from './commerce.repository.js';
import { CommerceService } from './commerce.service.js';
import { PAYMENT_PROVIDER, SandboxPaymentProvider } from './payment-provider.js';
import { PostgresCommerceRepository } from './postgres-commerce.repository.js';
import type { AppEnv } from '../../config/env.js';

@Module({
  imports: [AuthModule, EconomyModule, LiveProjectionModule],
  controllers: [CommerceController],
  providers: [
    {
      provide: COMMERCE_REPOSITORY,
      useFactory: (env: AppEnv, database: DatabaseService) => env.USE_FAKE_INTEGRATIONS === 1 || env.NODE_ENV === 'test'
        ? new InMemoryCommerceRepository()
        : new PostgresCommerceRepository(database),
      inject: [APP_ENV, DatabaseService],
    },
    { provide: PAYMENT_PROVIDER, useClass: SandboxPaymentProvider },
    CommerceService,
  ],
  exports: [CommerceService, COMMERCE_REPOSITORY, PAYMENT_PROVIDER],
})
export class CommerceModule {}
