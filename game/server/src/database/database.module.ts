import { Global, Module } from '@nestjs/common';
import { loadEnv } from '../config/env.js';
import { APP_ENV, DatabaseService } from './database.service.js';

@Global()
@Module({
  providers: [{ provide: APP_ENV, useFactory: () => loadEnv() }, DatabaseService],
  exports: [APP_ENV, DatabaseService],
})
export class DatabaseModule {}
