import { Controller, Get } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { APP_ENV } from './database/database.service.js';
import type { AppEnv } from './config/env.js';

@Controller('/v1')
export class AppController {
  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  @Get('/meta')
  meta(): Record<string, unknown> {
    const env = this.env;
    return {
      service: env.APP_NAME,
      version: env.APP_VERSION,
      env: env.NODE_ENV,
      features: {
        health: true,
        readiness: true,
        migrations: true,
        seed: true,
        leaderboards: true,
      },
    };
  }
}
