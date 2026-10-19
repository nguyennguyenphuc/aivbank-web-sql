export const CANDY_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type CandyColor = (typeof CANDY_COLORS)[number];
export type SpecialType = 'none' | 'striped-h' | 'striped-v' | 'wrapped' | 'rainbow';

export interface Coordinate { row: number; col: number }
export interface Candy { id: string; color: CandyColor; special: SpecialType }
export interface Blocker { kind: 'chocolate'; hp: number }
export interface Overlay { kind: 'ice'; hp: number }
export interface Occupant { kind: 'ingredient' }
export interface SpawnMetadata { enabled: boolean; ingredientExit?: boolean }

export interface BoardCell {
  playable: boolean;
  candy: Candy | null;
  blocker: Blocker | null;
  overlay: Overlay | null;
  occupant: Occupant | null;
  spawn: SpawnMetadata;
}

export interface BoardState {
  rows: number;
  cols: number;
  cells: BoardCell[][];
  seed: number;
  rngState: number;
  nextCandyId: number;
  shuffleCount: number;
}

export interface LayerSeed {
  row: number;
  col: number;
  hp?: number;
}

export interface BoardConfig {
  rows: number;
  cols: number;
  seed: number;
  colors: readonly CandyColor[];
  blocked?: readonly Coordinate[];
  ice?: readonly LayerSeed[];
  chocolate?: readonly LayerSeed[];
  ingredients?: readonly Coordinate[];
  ingredientExits?: readonly Coordinate[];
}

export type ObjectiveKind = 'score' | 'clear-ice' | 'clear-chocolate' | 'collect-color' | 'drop-ingredient' | 'defeat-boss';
export interface EngineObjective {
  kind: ObjectiveKind;
  target: number;
  current: number;
  color?: CandyColor;
}

export interface MatchRun {
  cells: Coordinate[];
  color: CandyColor;
  axis: 'horizontal' | 'vertical';
}

export interface MatchSet {
  cells: Coordinate[];
  runs: MatchRun[];
  specials: Array<Coordinate & { color: CandyColor; special: SpecialType }>;
}

export interface EngineMove { from: Coordinate; to: Coordinate }
export interface MoveRecord extends EngineMove {
  index: number;
  boardHashBefore: string;
  boardHashAfter: string;
}

export interface TurnResult {
  accepted: boolean;
  board: BoardState;
  objectives: EngineObjective[];
  scoreDelta: number;
  cascades: number;
  shuffled: boolean;
  record?: MoveRecord;
  reason?: 'not-adjacent' | 'blocked' | 'no-match';
}

export interface ReplayResult {
  valid: boolean;
  board: BoardState;
  objectives: EngineObjective[];
  score: number;
  acceptedMoves: number;
  finalBoardHash: string;
  reason?: string;
}
