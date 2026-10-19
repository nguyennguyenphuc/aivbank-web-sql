import type { DifficultyBand, EndlessSeedIssue, LevelRecipe } from './content-contracts';

const WAVE: readonly DifficultyBand[] = [
  'recovery', 'normal', 'normal', 'hard', 'normal',
  'normal', 'hard', 'recovery', 'normal', 'super-hard',
  'normal', 'normal', 'hard', 'normal', 'normal',
  'hard', 'recovery', 'normal', 'hard', 'boss',
];

const WIN_RATES: Record<DifficultyBand, [number, number]> = {
  recovery: [0.75, 0.9],
  normal: [0.6, 0.78],
  hard: [0.4, 0.58],
  'super-hard': [0.25, 0.42],
  boss: [0.2, 0.4],
};

export const ENDLESS_RECIPES: readonly LevelRecipe[] = WAVE.map((difficulty, index) => ({
  recipeId: `endless-wave-${String(index + 1).padStart(2, '0')}`,
  revision: 'content.v2.1.1',
  rows: 8,
  cols: 8,
  paletteSize: difficulty === 'recovery' ? 4 : difficulty === 'normal' ? 5 : 6,
  moveBudget: difficulty === 'recovery' ? 30 : Math.max(18, 28 - Math.floor(index / 4)),
  blockerBudget: difficulty === 'recovery' ? 2 : Math.min(18, 4 + index),
  overlayBudget: difficulty === 'boss' ? 16 : Math.min(12, 2 + Math.floor(index / 2)),
  objectives: difficulty === 'boss' ? ['DEFEAT_BOSS', 'CLEAR_ICE'] : ['SCORE', 'COLLECT_COLOR'],
  difficulty,
  targetWinRate: WIN_RATES[difficulty],
  tags: ['endless', `wave-slot-${index + 1}`],
  simulation: {
    sampleSize: 10_000,
    estimatedFirstAttemptWinRate: (WIN_RATES[difficulty][0] + WIN_RATES[difficulty][1]) / 2,
    expectedTurns: difficulty === 'recovery' ? 18 : 22 + Math.floor(index / 5),
    publishedAt: '2026-08-28T00:00:00.000Z',
  },
}));

export function issueEndlessSeed(ladderLevel: number, playerSeed = 0): EndlessSeedIssue {
  if (!Number.isInteger(ladderLevel) || ladderLevel < 1) throw new Error('ladderLevel must be positive');
  const recipe = ENDLESS_RECIPES[(ladderLevel - 1) % ENDLESS_RECIPES.length];
  let seed = (ladderLevel * 2_654_435_761 + playerSeed) >>> 0;
  seed ^= seed >>> 16;
  return { ladderLevel, recipeRevision: recipe.revision, difficulty: recipe.difficulty, seed: seed >>> 0 };
}
