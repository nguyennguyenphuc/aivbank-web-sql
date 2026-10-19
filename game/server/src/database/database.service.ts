import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { loadEnv, type AppEnv } from '../config/env.js';

export const APP_ENV = Symbol('APP_ENV');

export interface QueryResultRow {
  [key: string]: unknown;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool | null = null;
  private readonly env: AppEnv;

  constructor(@Inject(APP_ENV) env?: AppEnv) {
    this.env = env ?? loadEnv();
  }

  private get useFake(): boolean {
    return this.env.USE_FAKE_INTEGRATIONS === 1 || this.env.NODE_ENV === 'test';
  }

  async onModuleInit(): Promise<void> {
    if (this.useFake) {
      this.logger.warn('DatabaseService running in fake mode');
      return;
    }

    this.pool = new Pool({
      connectionString: this.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      application_name: `${this.env.APP_NAME}:${this.env.APP_VERSION}`,
    });
    await this.pool.query('select 1 as ok');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    if (this.useFake) {
      return [];
    }
    const pool = await this.ensurePool();
    const result = await pool.query<T>(text, params);
    return result.rows;
  }

  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (this.useFake) {
      throw new Error('withClient is unavailable in fake integration mode');
    }
    const pool = await this.ensurePool();
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async ping(): Promise<{ ok: boolean; mode: 'real' | 'fake' }> {
    if (this.useFake) {
      return { ok: true, mode: 'fake' };
    }
    await this.query('select 1 as ok');
    return { ok: true, mode: 'real' };
  }

  private async ensurePool(): Promise<Pool> {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.env.DATABASE_URL,
        max: 10,
        idleTimeoutMillis: 30_000,
        application_name: `${this.env.APP_NAME}:${this.env.APP_VERSION}`,
      });
    }
    return this.pool;
  }
}
