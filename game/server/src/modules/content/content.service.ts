import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SERVER_CONTENT_REVISIONS } from './content-catalog.js';
import type { ServerContentRevision, ServerPublishedLevel } from './content-types.js';

@Injectable()
export class ContentService {
  getRevision(revision = 'content.v2.1.1'): ServerContentRevision {
    const content = SERVER_CONTENT_REVISIONS[revision];
    if (!content) throw new NotFoundException(`Unknown content revision: ${revision}`);
    return content;
  }

  getLevel(revision: string, levelId: number, appVersion?: string): ServerPublishedLevel {
    if (!Number.isInteger(levelId) || levelId < 1 || levelId > 60) throw new BadRequestException('levelId must be from 1 to 60');
    const selectedRevision = levelId >= 28 && levelId <= 30 && appVersion === 'v2.1.0' ? 'content.v2.1.0' : revision;
    return this.getRevision(selectedRevision).campaign[levelId - 1];
  }

  issueEndlessSeed(ladderLevel: number, playerSeed = 0): { ladderLevel: number; recipeRevision: string; difficulty: string; seed: number } {
    if (!Number.isInteger(ladderLevel) || ladderLevel < 1) throw new BadRequestException('ladderLevel must be positive');
    if (!Number.isSafeInteger(playerSeed)) throw new BadRequestException('playerSeed must be a safe integer');
    const recipe = this.getRevision().recipes[(ladderLevel - 1) % 20];
    let seed = (ladderLevel * 2_654_435_761 + playerSeed) >>> 0;
    seed ^= seed >>> 16;
    return { ladderLevel, recipeRevision: recipe.revision, difficulty: recipe.difficulty, seed: seed >>> 0 };
  }
}
