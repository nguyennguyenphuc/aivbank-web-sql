import type { BoardConfig, CandyColor, EngineObjective } from '../../../../shared/engine/engine-types.js';

export interface EngineDefinition {
  board: BoardConfig;
  objectives: EngineObjective[];
  moveBudget: number;
}

const COLORS: readonly CandyColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

export function createEngineDefinition(levelId: number, seed: number): EngineDefinition {
  const early = earlyLevelDefinition(levelId, seed);
  if (early) return early;
  const recovery = levelId % 10 === 1;
  const hard = levelId % 5 === 0;
  const boss = levelId % 10 === 0;
  const colors = COLORS.slice(0, recovery ? 4 : hard ? 6 : 5);
  const ice = levelId % 3 === 0 ? symmetricCells(levelId).map(cell => ({ ...cell, hp: hard ? 2 : 1 })) : [];
  const chocolate = levelId % 4 === 0 ? symmetricCells(levelId + 1) : [];
  const objectives: EngineObjective[] = boss
    ? [{ kind: 'defeat-boss', target: 80 + levelId * 2, current: 0 }]
    : levelId % 3 === 0
      ? [{ kind: 'clear-ice', target: ice.reduce((sum, cell) => sum + (cell.hp ?? 1), 0), current: 0 }]
      : levelId % 4 === 0
        ? [{ kind: 'clear-chocolate', target: chocolate.length, current: 0 }]
        : [{ kind: 'score', target: levelId * 400, current: 0 }];
  return {
    board: { rows: 8, cols: 8, seed, colors, ice, chocolate },
    objectives,
    moveBudget: boss ? 24 : recovery ? 30 : hard ? 22 : 27,
  };
}

function earlyLevelDefinition(levelId: number, seed: number): EngineDefinition | undefined {
  const configs: Record<number, { rows: number; cols: number; colors: number; target: number; moves: number }> = {
    1: { rows: 3, cols: 3, colors: 3, target: 240, moves: 8 },
    2: { rows: 4, cols: 4, colors: 4, target: 520, moves: 10 },
    3: { rows: 5, cols: 5, colors: 4, target: 900, moves: 14 },
    4: { rows: 6, cols: 6, colors: 5, target: 1_400, moves: 16 },
    5: { rows: 7, cols: 7, colors: 5, target: 2_200, moves: 20 },
  };
  const config = configs[levelId];
  if (!config) return undefined;
  return {
    board: { rows: config.rows, cols: config.cols, seed, colors: COLORS.slice(0, config.colors) },
    objectives: [{ kind: 'score', target: config.target, current: 0 }],
    moveBudget: config.moves,
  };
}

function symmetricCells(seed: number): Array<{ row: number; col: number }> {
  const cells: Array<{ row: number; col: number }> = [];
  for (let index = 0; index < 4; index++) {
    const row = 2 + ((seed + index) % 4);
    const col = 1 + ((seed * 3 + index) % 3);
    cells.push({ row, col }, { row, col: 7 - col });
  }
  return cells.filter((cell, index, all) => all.findIndex(other => other.row === cell.row && other.col === cell.col) === index);
}
