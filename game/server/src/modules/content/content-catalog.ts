import type { ServerContentRevision, ServerDifficulty, ServerLevelRecipe, ServerPublishedLevel } from './content-types.js';

const WAVE: readonly ServerDifficulty[] = [
  'recovery', 'normal', 'normal', 'hard', 'normal', 'normal', 'hard', 'recovery', 'normal', 'super-hard',
  'normal', 'normal', 'hard', 'normal', 'normal', 'hard', 'recovery', 'normal', 'hard', 'boss',
];
const RATES: Record<ServerDifficulty, [number, number]> = {
  recovery: [0.75, 0.9], normal: [0.6, 0.78], hard: [0.4, 0.58], 'super-hard': [0.25, 0.42], boss: [0.2, 0.4],
};

export function canonicalSeed(levelId: number, patch: number): number {
  let value = Math.imul(levelId + patch * 101, 2_654_435_761) >>> 0;
  value ^= value >>> 16;
  return value >>> 0;
}

export function buildCampaign(revision: 'content.v2.1.0' | 'content.v2.1.1'): readonly ServerPublishedLevel[] {
  const patch = revision.endsWith('.1') ? 1 : 0;
  return Object.freeze(Array.from({ length: 60 }, (_, index) => {
    const levelId = index + 1;
    const variant = levelId >= 28 && levelId <= 30 ? (patch ? 'v2.1.1' : 'v2.1.0') : undefined;
    return Object.freeze({
      levelId, revision, recipeId: `campaign-${String(levelId).padStart(2, '0')}`,
      seed: canonicalSeed(levelId, variant ? patch : 1), appVariant: variant,
      tutorialMessageKey: levelId === 4 ? 'tutorial.step.4.specials'
        : levelId === 30 && patch ? 'tutorial.step.4.hotfix' : undefined,
    }) satisfies ServerPublishedLevel;
  }));
}

export const SERVER_ENDLESS_RECIPES: readonly ServerLevelRecipe[] = Object.freeze(WAVE.map((difficulty, index) => Object.freeze({
  recipeId: `endless-wave-${String(index + 1).padStart(2, '0')}`,
  revision: 'content.v2.1.1', difficulty, targetWinRate: RATES[difficulty],
})));

export const SERVER_CONTENT_REVISIONS: Readonly<Record<string, ServerContentRevision>> = Object.freeze({
  'content.v2.1.0': Object.freeze({ revision: 'content.v2.1.0', campaign: buildCampaign('content.v2.1.0'), recipes: SERVER_ENDLESS_RECIPES }),
  'content.v2.1.1': Object.freeze({ revision: 'content.v2.1.1', campaign: buildCampaign('content.v2.1.1'), recipes: SERVER_ENDLESS_RECIPES }),
});
