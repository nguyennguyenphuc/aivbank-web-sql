export type CandyColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';

export type SpecialType = 'none' | 'striped_h' | 'striped_v' | 'wrapped_bomb' | 'rainbow_candy';

export type ObjectiveType =
  | 'SCORE'
  | 'CLEAR_ICE'
  | 'CLEAR_CHOCOLATE'
  | 'COLLECT_COLOR'
  | 'DROP_INGREDIENT'
  | 'DEFEAT_BOSS';

export interface Objective {
  type: ObjectiveType;
  target: number;
  current: number;
  color?: CandyColor;
  descriptionVi: string;
  descriptionEn: string;
}

export interface CellTile {
  id: string;
  row: number;
  col: number;
  color: CandyColor;
  special: SpecialType;
  iceLevel: number; // 0, 1, 2
  hasChocolate: boolean;
  isIngredient: boolean;
  isMatched?: boolean;
  isClearing?: boolean;
  isHinted?: boolean;
}

export interface BossInfo {
  nameVi: string;
  nameEn: string;
  avatar: string;
  maxHp: number;
  currentHp: number;
  dialogueVi?: string;
  dialogueEn?: string;
}

export interface LevelConfig {
  id: number;
  worldId: number;
  worldNameVi: string;
  worldNameEn: string;
  worldTheme: 'garden' | 'ice' | 'choco' | 'castle';
  nameVi: string;
  nameEn: string;
  rows: number;
  cols: number;
  moves: number;
  timeLimit?: number; // optional timer mode in seconds
  starScores: [number, number, number]; // [1 star, 2 stars, 3 stars]
  allowedColors: CandyColor[];
  objectives: Objective[];
  initialIce?: { row: number; col: number; level: number }[];
  initialChocolate?: { row: number; col: number }[];
  initialIngredients?: { row: number; col: number }[];
  maxIngredientsSpawn?: number;
  blockedCells?: { row: number; col: number }[];
  boss?: BossInfo;
  tipVi: string;
  tipEn: string;
  seed?: number;
  contentRevision?: string;
  appVariant?: 'v2.1.0' | 'v2.1.1';
  tutorialMessageKey?: string;
  difficulty?: 'recovery' | 'normal' | 'hard' | 'super-hard' | 'boss';
}

export type BoosterType = 'hammer' | 'shuffle' | 'lightning' | 'extraMoves';

export interface PlayerInventory {
  coins: number;
  boosters: Record<BoosterType, number>;
  starsPerLevel: Record<number, number>; // levelId -> 1, 2, 3 stars
  highScores: Record<number, number>;
  unlockedLevel: number;
  lastDailySpinDate?: string;
  soundEnabled: boolean;
  musicEnabled: boolean;
  language: 'vi' | 'en';
}

export interface MatchResult {
  matches: { row: number; col: number }[];
  createdSpecials: { row: number; col: number; special: SpecialType; color: CandyColor }[];
  comboMultiplier: number;
}

export interface ActiveEffect {
  id: string;
  type: 'rocket_h' | 'rocket_v' | 'bomb_blast' | 'rainbow_pulse' | 'combo_text' | 'star_burst';
  row: number;
  col: number;
  text?: string;
  color?: string;
}
