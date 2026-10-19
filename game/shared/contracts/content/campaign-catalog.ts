import type { ContentRevision, PublishedLevel } from './content-contracts';
import { ENDLESS_RECIPES } from './endless-recipes';

const canonicalSeed = (levelId: number, patch: number): number => {
  let value = Math.imul(levelId + patch * 101, 2_654_435_761) >>> 0;
  value ^= value >>> 16;
  return value >>> 0;
};

export const APP_LEVEL_VARIANTS = Object.freeze({
  28: Object.freeze({
    'v2.1.0': { levelId: 28, revision: 'content.v2.1.0', recipeId: 'campaign-28', seed: canonicalSeed(28, 0), appVariant: 'v2.1.0' },
    'v2.1.1': { levelId: 28, revision: 'content.v2.1.1', recipeId: 'campaign-28', seed: canonicalSeed(28, 1), appVariant: 'v2.1.1' },
  }),
  29: Object.freeze({
    'v2.1.0': { levelId: 29, revision: 'content.v2.1.0', recipeId: 'campaign-29', seed: canonicalSeed(29, 0), appVariant: 'v2.1.0' },
    'v2.1.1': { levelId: 29, revision: 'content.v2.1.1', recipeId: 'campaign-29', seed: canonicalSeed(29, 1), appVariant: 'v2.1.1' },
  }),
  30: Object.freeze({
    'v2.1.0': { levelId: 30, revision: 'content.v2.1.0', recipeId: 'campaign-30', seed: canonicalSeed(30, 0), appVariant: 'v2.1.0' },
    'v2.1.1': { levelId: 30, revision: 'content.v2.1.1', recipeId: 'campaign-30', seed: canonicalSeed(30, 1), appVariant: 'v2.1.1', tutorialMessageKey: 'tutorial.step.4.hotfix' },
  }),
} satisfies Record<28 | 29 | 30, Record<'v2.1.0' | 'v2.1.1', PublishedLevel>>);

export const CANONICAL_CAMPAIGN: readonly PublishedLevel[] = Object.freeze(
  Array.from({ length: 60 }, (_, index): PublishedLevel => {
    const levelId = index + 1;
    if (levelId >= 28 && levelId <= 30) return APP_LEVEL_VARIANTS[levelId as 28 | 29 | 30]['v2.1.1'];
    return Object.freeze({
      levelId,
      revision: 'content.v2.1.1',
      recipeId: `campaign-${String(levelId).padStart(2, '0')}`,
      seed: canonicalSeed(levelId, 1),
      tutorialMessageKey: levelId === 4 ? 'tutorial.step.4.specials' : undefined,
    });
  }),
);

export const CONTENT_REVISIONS: Readonly<Record<string, ContentRevision>> = Object.freeze({
  'content.v2.1.0': Object.freeze({
    revision: 'content.v2.1.0',
    campaign: Object.freeze(CANONICAL_CAMPAIGN.map(level => level.levelId >= 28 && level.levelId <= 30
      ? APP_LEVEL_VARIANTS[level.levelId as 28 | 29 | 30]['v2.1.0'] : { ...level, revision: 'content.v2.1.0' })),
    recipes: ENDLESS_RECIPES,
  }),
  'content.v2.1.1': Object.freeze({ revision: 'content.v2.1.1', campaign: CANONICAL_CAMPAIGN, recipes: ENDLESS_RECIPES }),
});
