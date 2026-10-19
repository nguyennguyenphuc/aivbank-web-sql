import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';
import { loadEnv, type AppEnv } from '../config/env.js';
import { APP_ENV } from '../database/database.service.js';

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private client: RedisClientType | null = null;
  private readonly env: AppEnv;

  constructor(@Inject(APP_ENV) env?: AppEnv) {
    this.env = env ?? loadEnv();
  }

  private get useFake(): boolean {
    return this.env.USE_FAKE_INTEGRATIONS === 1 || this.env.NODE_ENV === 'test';
  }

  async onModuleInit(): Promise<void> {
    if (this.useFake) {
      this.logger.warn('CacheService running in fake mode');
      return;
    }

    this.client = createClient({ url: this.env.REDIS_URL });
    this.client.on('error', err => this.logger.error(err));
    await this.client.connect();
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }

  async ping(): Promise<{ ok: boolean; mode: 'real' | 'fake' }> {
    if (this.useFake) {
      return { ok: true, mode: 'fake' };
    }
    const client = await this.ensureClient();
    await client.ping();
    return { ok: true, mode: 'real' };
  }

  async zAdd(key: string, members: Array<{ score: number; value: string }>): Promise<number> {
    if (this.useFake) {
      return members.length;
    }
    const client = await this.ensureClient();
    return client.zAdd(key, members);
  }

  async zRangeWithScores(key: string, start: number, stop: number): Promise<Array<{ value: string; score: number }>> {
    if (this.useFake) return [];
    const client = await this.ensureClient();
    return client.zRangeWithScores(key, start, stop, { REV: true });
  }

  async zRevRank(key: string, value: string): Promise<number | null> {
    if (this.useFake) return null;
    const client = await this.ensureClient();
    return client.zRevRank(key, value);
  }

  async delete(key: string): Promise<number> {
    if (this.useFake) return 0;
    const client = await this.ensureClient();
    return client.del(key);
  }

  private async ensureClient(): Promise<RedisClientType> {
    if (!this.client) {
      this.client = createClient({ url: this.env.REDIS_URL });
      this.client.on('error', err => this.logger.error(err));
      await this.client.connect();
    }
    return this.client;
  }
}
