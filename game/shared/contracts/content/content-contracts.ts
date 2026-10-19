export type DifficultyBand = 'recovery' | 'normal' | 'hard' | 'super-hard' | 'boss';

export interface SimulationMetadata {
  sampleSize: number;
  estimatedFirstAttemptWinRate: number;
  expectedTurns: number;
  publishedAt: string;
}

export interface LevelRecipe {
  recipeId: string;
  revision: string;
  rows: number;
  cols: number;
  paletteSize: 4 | 5 | 6;
  moveBudget: number;
  blockerBudget: number;
  overlayBudget: number;
  objectives: string[];
  difficulty: DifficultyBand;
  targetWinRate: [number, number];
  tags: string[];
  simulation: SimulationMetadata;
}

export interface PublishedLevel {
  levelId: number;
  revision: string;
  recipeId: string;
  seed: number;
  appVariant?: 'v2.1.0' | 'v2.1.1';
  tutorialMessageKey?: string;
}

export interface ContentRevision {
  revision: string;
  campaign: readonly PublishedLevel[];
  recipes: readonly LevelRecipe[];
}

export interface EndlessSeedIssue {
  ladderLevel: number;
  recipeRevision: string;
  difficulty: DifficultyBand;
  seed: number;
}
