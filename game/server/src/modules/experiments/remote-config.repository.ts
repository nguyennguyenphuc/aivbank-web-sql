import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { RemoteConfigRevision } from '../../../../shared/contracts/experiments/index.js';

export interface RemoteConfigRepository {
  publish(revision: RemoteConfigRevision): Promise<void>;
  get(revision: string): Promise<RemoteConfigRevision | undefined>;
  active(): Promise<RemoteConfigRevision | undefined>;
  activate(revision: string, expectedActiveRevision?: string): Promise<void>;
  latestSequence(): Promise<number>;
}

export const REMOTE_CONFIG_REPOSITORY = Symbol('REMOTE_CONFIG_REPOSITORY');

@Injectable()
export class InMemoryRemoteConfigRepository implements RemoteConfigRepository {
  private readonly revisions = new Map<string, RemoteConfigRevision>();
  private activeRevision?: string;

  async publish(revision: RemoteConfigRevision): Promise<void> {
    const existing = this.revisions.get(revision.revision);
    if (existing && JSON.stringify(existing) !== JSON.stringify(revision)) throw new ConflictException('Config revisions are immutable');
    if ([...this.revisions.values()].some(item => item.sequence === revision.sequence && item.revision !== revision.revision)) {
      throw new ConflictException('Config sequence already exists');
    }
    this.revisions.set(revision.revision, structuredClone(revision));
  }

  async get(revision: string): Promise<RemoteConfigRevision | undefined> {
    const config = this.revisions.get(revision);
    return config ? structuredClone(config) : undefined;
  }

  async active(): Promise<RemoteConfigRevision | undefined> {
    return this.activeRevision ? this.get(this.activeRevision) : undefined;
  }

  async activate(revision: string, expectedActiveRevision?: string): Promise<void> {
    const target = this.revisions.get(revision);
    if (!target) throw new NotFoundException('Config revision not found');
    if (expectedActiveRevision !== undefined && this.activeRevision !== expectedActiveRevision) {
      throw new ConflictException('Active config changed');
    }
    const active = this.activeRevision ? this.revisions.get(this.activeRevision) : undefined;
    if (active && target.sequence < active.sequence) throw new ConflictException('Stale config cannot be activated; publish a rollback revision');
    this.activeRevision = revision;
  }

  async latestSequence(): Promise<number> {
    return Math.max(0, ...[...this.revisions.values()].map(config => config.sequence));
  }
}
