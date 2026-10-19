import { Injectable } from '@nestjs/common';
import type { PlayerSettings, PlayerSnapshot, PracticeResult } from './player.types.js';

export const PLAYER_REPOSITORY = Symbol('PLAYER_REPOSITORY');

export interface PlayerRepository {
  find(accountId: string): Promise<PlayerSnapshot | undefined>;
  save(snapshot: PlayerSnapshot, expectedProgressRevision?: number): Promise<void>;
  savePractice(accountId: string, result: PracticeResult): Promise<boolean>;
  hasPractice(accountId: string, operationId: string): Promise<boolean>;
  applyVerifiedOutcome(accountId: string, runId: string, levelId: number, score: number, won: boolean): Promise<boolean>;
}

export const DEFAULT_SETTINGS: PlayerSettings = { sound: true, music: true, reducedMotion: false, locale: 'vi' };

@Injectable()
export class InMemoryPlayerRepository implements PlayerRepository {
  private readonly snapshots = new Map<string, PlayerSnapshot>();
  private readonly practiceOperations = new Set<string>();
  private readonly verifiedRuns = new Set<string>();

  async find(accountId: string): Promise<PlayerSnapshot | undefined> {
    const value = this.snapshots.get(accountId);
    return value ? structuredClone(value) : undefined;
  }

  async save(snapshot: PlayerSnapshot, expectedProgressRevision?: number): Promise<void> {
    const current = this.snapshots.get(snapshot.accountId);
    if (expectedProgressRevision !== undefined && current?.progress.revision !== expectedProgressRevision) {
      throw new Error('Progress revision conflict');
    }
    this.snapshots.set(snapshot.accountId, structuredClone(snapshot));
  }

  async savePractice(accountId: string, result: PracticeResult): Promise<boolean> {
    const key = `${accountId}:${result.operationId}`;
    if (this.practiceOperations.has(key)) return false;
    this.practiceOperations.add(key);
    return true;
  }

  async hasPractice(accountId: string, operationId: string): Promise<boolean> {
    return this.practiceOperations.has(`${accountId}:${operationId}`);
  }

  async applyVerifiedOutcome(accountId: string, runId: string, levelId: number, score: number, won: boolean): Promise<boolean> {
    if (this.verifiedRuns.has(runId)) return false;
    const snapshot = this.snapshots.get(accountId);
    if (!snapshot) throw new Error('Player snapshot not found');
    this.verifiedRuns.add(runId);
    snapshot.progress = {
      unlockedLevel: won ? Math.max(snapshot.progress.unlockedLevel, levelId + 1) : snapshot.progress.unlockedLevel,
      starsEarned: snapshot.progress.starsEarned + (won ? 1 : 0),
      totalScore: snapshot.progress.totalScore + score,
      lastLevelId: levelId,
      revision: snapshot.progress.revision + 1,
    };
    snapshot.updatedAt = new Date().toISOString();
    return true;
  }
}
