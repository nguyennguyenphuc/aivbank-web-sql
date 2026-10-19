export interface CachedRank {
  playerId: string;
  score: number;
  rank: number;
}

export interface LeaderboardCache {
  put(namespace: string, playerId: string, score: number): Promise<void>;
  top(namespace: string, limit: number): Promise<CachedRank[]>;
  around(namespace: string, playerId: string, radius: number): Promise<CachedRank[]>;
  clear(namespace: string): Promise<void>;
}

export const LEADERBOARD_CACHE = Symbol('LEADERBOARD_CACHE');

export class InMemoryLeaderboardCache implements LeaderboardCache {
  private readonly sets = new Map<string, Map<string, number>>();

  async put(namespace: string, playerId: string, score: number): Promise<void> {
    const set = this.sets.get(namespace) ?? new Map<string, number>();
    set.set(playerId, Math.max(score, set.get(playerId) ?? 0));
    this.sets.set(namespace, set);
  }

  async top(namespace: string, limit: number): Promise<CachedRank[]> {
    return this.sorted(namespace).slice(0, limit).map((entry, index) => ({ ...entry, rank: index + 1 }));
  }

  async around(namespace: string, playerId: string, radius: number): Promise<CachedRank[]> {
    const sorted = this.sorted(namespace);
    const index = sorted.findIndex(entry => entry.playerId === playerId);
    if (index < 0) return [];
    const start = Math.max(0, index - radius);
    return sorted.slice(start, index + radius + 1).map((entry, offset) => ({ ...entry, rank: start + offset + 1 }));
  }

  async clear(namespace: string): Promise<void> {
    this.sets.delete(namespace);
  }

  private sorted(namespace: string): Array<Omit<CachedRank, 'rank'>> {
    return [...(this.sets.get(namespace) ?? new Map()).entries()]
      .map(([playerId, score]) => ({ playerId, score }))
      .sort((a, b) => b.score - a.score || a.playerId.localeCompare(b.playerId));
  }
}

export interface RedisSortedSetClient {
  zAdd(key: string, members: Array<{ score: number; value: string }>): Promise<number>;
  zRangeWithScores(key: string, start: number, stop: number, options: { REV: true }): Promise<Array<{ value: string; score: number }>>;
  zRevRank(key: string, member: string): Promise<number | null>;
  del(key: string): Promise<number>;
}

export class RedisCompatibleLeaderboardCache implements LeaderboardCache {
  constructor(private readonly client: RedisSortedSetClient) {}

  async put(namespace: string, playerId: string, score: number): Promise<void> {
    await this.client.zAdd(namespace, [{ score, value: playerId }]);
  }

  async top(namespace: string, limit: number): Promise<CachedRank[]> {
    const rows = await this.client.zRangeWithScores(namespace, 0, Math.max(0, limit - 1), { REV: true });
    return rows.map((row, index) => ({ playerId: row.value, score: row.score, rank: index + 1 }));
  }

  async around(namespace: string, playerId: string, radius: number): Promise<CachedRank[]> {
    const rank = await this.client.zRevRank(namespace, playerId);
    if (rank === null) return [];
    const start = Math.max(0, rank - radius);
    const rows = await this.client.zRangeWithScores(namespace, start, rank + radius, { REV: true });
    return rows.map((row, index) => ({ playerId: row.value, score: row.score, rank: start + index + 1 }));
  }

  async clear(namespace: string): Promise<void> {
    await this.client.del(namespace);
  }
}

@Injectable()
export class CacheServiceLeaderboardCache implements LeaderboardCache {
  constructor(@Inject(CacheService) private readonly cache: CacheService) {}

  async put(namespace: string, playerId: string, score: number): Promise<void> {
    await this.cache.zAdd(namespace, [{ score, value: playerId }]);
  }

  async top(namespace: string, limit: number): Promise<CachedRank[]> {
    const rows = await this.cache.zRangeWithScores(namespace, 0, Math.max(0, limit - 1));
    return rows.map((row, index) => ({ playerId: row.value, score: row.score, rank: index + 1 }));
  }

  async around(namespace: string, playerId: string, radius: number): Promise<CachedRank[]> {
    const rank = await this.cache.zRevRank(namespace, playerId);
    if (rank === null) return [];
    const start = Math.max(0, rank - radius);
    const rows = await this.cache.zRangeWithScores(namespace, start, rank + radius);
    return rows.map((row, index) => ({ playerId: row.value, score: row.score, rank: start + index + 1 }));
  }

  async clear(namespace: string): Promise<void> {
    await this.cache.delete(namespace);
  }
}
import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '../../cache/cache.service.js';
