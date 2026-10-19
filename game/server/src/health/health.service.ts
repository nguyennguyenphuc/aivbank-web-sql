import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { CacheService } from '../cache/cache.service.js';

export interface HealthStatus {
  ok: boolean;
  dependencies: {
    postgres: { ok: boolean; mode: 'real' | 'fake' };
    redis: { ok: boolean; mode: 'real' | 'fake' };
  };
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CacheService) private readonly cache: CacheService,
  ) {}

  async liveness(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async readiness(): Promise<HealthStatus> {
    const [postgres, redis] = await Promise.all([
      this.database.ping(),
      this.cache.ping(),
    ]);

    return {
      ok: postgres.ok && redis.ok,
      dependencies: {
        postgres,
        redis,
      },
    };
  }
}
