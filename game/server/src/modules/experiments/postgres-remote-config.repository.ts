import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { RemoteConfigRevision } from '../../../../shared/contracts/experiments/index.js';
import { DatabaseService } from '../../database/database.service.js';
import type { RemoteConfigRepository } from './remote-config.repository.js';

interface ConfigRow { [key: string]: unknown; revision: string; sequence: number; payload: RemoteConfigRevision }

@Injectable()
export class PostgresRemoteConfigRepository implements RemoteConfigRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async publish(revision: RemoteConfigRevision): Promise<void> {
    const current = await this.database.query<ConfigRow>('select revision, sequence, payload from remote_config_revisions where revision = $1', [revision.revision]);
    if (current[0] && JSON.stringify(current[0].payload) !== JSON.stringify(revision)) throw new ConflictException('Config revisions are immutable');
    await this.database.query(
      `insert into remote_config_revisions (revision, sequence, payload, created_at)
       values ($1, $2, $3::jsonb, $4) on conflict (revision) do nothing`,
      [revision.revision, revision.sequence, JSON.stringify(revision), revision.createdAt],
    );
  }

  async get(revision: string): Promise<RemoteConfigRevision | undefined> {
    const rows = await this.database.query<ConfigRow>('select revision, sequence, payload from remote_config_revisions where revision = $1', [revision]);
    return rows[0] ? structuredClone(rows[0].payload) : undefined;
  }

  async active(): Promise<RemoteConfigRevision | undefined> {
    const rows = await this.database.query<ConfigRow>('select revision, sequence, payload from remote_config_revisions where active');
    return rows[0] ? structuredClone(rows[0].payload) : undefined;
  }

  async activate(revision: string, expectedActiveRevision?: string): Promise<void> {
    await this.database.withClient(async client => {
      await client.query('begin');
      try {
        const active = await client.query<ConfigRow>('select revision, sequence, payload from remote_config_revisions where active for update');
        if (expectedActiveRevision !== undefined && active.rows[0]?.revision !== expectedActiveRevision) throw new ConflictException('Active config changed');
        const target = await client.query<ConfigRow>('select revision, sequence, payload from remote_config_revisions where revision = $1', [revision]);
        if (!target.rows[0]) throw new NotFoundException('Config revision not found');
        if (active.rows[0] && target.rows[0].sequence < active.rows[0].sequence) throw new ConflictException('Stale config cannot be activated; publish a rollback revision');
        await client.query('update remote_config_revisions set active = false where active');
        await client.query('update remote_config_revisions set active = true where revision = $1', [revision]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    });
  }

  async latestSequence(): Promise<number> {
    const rows = await this.database.query<{ [key: string]: unknown; sequence: number }>('select coalesce(max(sequence), 0)::integer sequence from remote_config_revisions');
    return rows[0]?.sequence ?? 0;
  }
}
