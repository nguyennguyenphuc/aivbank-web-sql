export type ServerDifficulty = 'recovery' | 'normal' | 'hard' | 'super-hard' | 'boss';

export interface ServerPublishedLevel {
  levelId: number;
  revision: string;
  recipeId: string;
  seed: number;
  appVariant?: 'v2.1.0' | 'v2.1.1';
  tutorialMessageKey?: string;
}

export interface ServerLevelRecipe {
  recipeId: string;
  revision: string;
  difficulty: ServerDifficulty;
  targetWinRate: [number, number];
}

export interface ServerContentRevision {
  revision: string;
  campaign: readonly ServerPublishedLevel[];
  recipes: readonly ServerLevelRecipe[];
}
