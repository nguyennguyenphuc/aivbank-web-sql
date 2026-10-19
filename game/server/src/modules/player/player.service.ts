import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { DEFAULT_SETTINGS, PLAYER_REPOSITORY, type PlayerRepository } from './player.repository.js';
import type { PlayerProgress, PlayerSettings, PlayerSnapshot, PracticeResult } from './player.types.js';

@Injectable()
export class PlayerService {
  constructor(@Inject(PLAYER_REPOSITORY) private readonly repository: PlayerRepository) {}

  async restore(accountId: string, displayName = 'Player'): Promise<PlayerSnapshot> {
    const existing = await this.repository.find(accountId);
    if (existing) return existing;
    const snapshot: PlayerSnapshot = {
      accountId,
      displayName,
      settings: structuredClone(DEFAULT_SETTINGS),
      progress: { unlockedLevel: 1, starsEarned: 0, totalScore: 0, lastLevelId: 1, revision: 0 },
      updatedAt: new Date().toISOString(),
    };
    await this.repository.save(snapshot);
    return snapshot;
  }

  async updateSettings(accountId: string, patch: Partial<PlayerSettings>): Promise<PlayerSnapshot> {
    const snapshot = await this.restore(accountId);
    const locale = patch.locale?.trim();
    if (locale !== undefined && !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale)) throw new BadRequestException('Invalid locale');
    snapshot.settings = { ...snapshot.settings, ...patch, ...(locale ? { locale } : {}) };
    snapshot.updatedAt = new Date().toISOString();
    await this.repository.save(snapshot);
    return snapshot;
  }

  async commitProgress(accountId: string, update: Omit<PlayerProgress, 'revision'> & { expectedRevision: number }): Promise<PlayerSnapshot> {
    const snapshot = await this.restore(accountId);
    if (snapshot.progress.revision !== update.expectedRevision) throw new ConflictException('Progress revision conflict');
    if (update.unlockedLevel < snapshot.progress.unlockedLevel || update.starsEarned < snapshot.progress.starsEarned || update.totalScore < snapshot.progress.totalScore) {
      throw new BadRequestException('Progress cannot move backwards');
    }
    snapshot.progress = { ...update, revision: snapshot.progress.revision + 1 };
    snapshot.updatedAt = new Date().toISOString();
    await this.repository.save(snapshot, update.expectedRevision);
    return snapshot;
  }

  async syncPractice(accountId: string, results: PracticeResult[]): Promise<{ accepted: string[]; duplicates: string[] }> {
    const accepted: string[] = [];
    const duplicates: string[] = [];
    for (const result of results) {
      if (result.ranked !== false || result.levelId < 1 || result.score < 0 || result.stars < 0 || result.stars > 3) {
        throw new BadRequestException('Invalid unranked practice result');
      }
      (await this.repository.savePractice(accountId, result) ? accepted : duplicates).push(result.operationId);
    }
    return { accepted, duplicates };
  }

  async applyVerifiedOutcome(accountId: string, runId: string, levelId: number, score: number, won: boolean): Promise<PlayerSnapshot> {
    await this.restore(accountId);
    await this.repository.applyVerifiedOutcome(accountId, runId, levelId, score, won);
    const updated = await this.repository.find(accountId);
    if (!updated) throw new Error('Verified progress snapshot was not persisted');
    return updated;
  }

  async resetSettings(accountId: string): Promise<PlayerSnapshot> {
    const snapshot = await this.restore(accountId);
    snapshot.settings = structuredClone(DEFAULT_SETTINGS);
    snapshot.updatedAt = new Date().toISOString();
    await this.repository.save(snapshot);
    return snapshot;
  }
}
