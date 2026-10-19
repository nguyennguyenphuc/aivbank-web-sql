import { adjacentPositions } from './gravity';
import type { BoardState, Coordinate, EngineObjective } from './engine-types';

export interface ClearResult {
  board: BoardState;
  objectives: EngineObjective[];
  clearedCandies: number;
}

export function clearCells(
  board: BoardState,
  positions: readonly Coordinate[],
  objectives: readonly EngineObjective[],
  score: number,
): ClearResult {
  const updated = objectives.map(objective => ({ ...objective }));
  const unique = new Map(positions.map(position => [`${position.row},${position.col}`, position]));
  const chocolate = new Map<string, Coordinate>();
  let clearedCandies = 0;
  for (const position of unique.values()) {
    const cell = board.cells[position.row]?.[position.col];
    if (!cell?.playable) continue;
    if (cell.candy) {
      clearedCandies++;
      increment(updated, 'collect-color', 1, cell.candy.color);
      cell.candy = null;
    }
    if (cell.overlay) {
      cell.overlay.hp--;
      if (cell.overlay.hp <= 0) {
        cell.overlay = null;
        increment(updated, 'clear-ice', 1);
      }
    }
    if (cell.blocker) chocolate.set(`${position.row},${position.col}`, position);
    adjacentPositions(board, position).forEach(next => {
      if (board.cells[next.row][next.col].blocker) chocolate.set(`${next.row},${next.col}`, next);
    });
  }
  for (const position of chocolate.values()) {
    const cell = board.cells[position.row][position.col];
    if (!cell.blocker) continue;
    cell.blocker.hp--;
    if (cell.blocker.hp <= 0) {
      cell.blocker = null;
      increment(updated, 'clear-chocolate', 1);
    }
  }
  increment(updated, 'score', score);
  increment(updated, 'defeat-boss', Math.max(1, Math.floor(clearedCandies / 3)));
  return { board, objectives: updated, clearedCandies };
}

export function addDroppedIngredients(objectives: EngineObjective[], count: number): EngineObjective[] {
  const updated = objectives.map(objective => ({ ...objective }));
  increment(updated, 'drop-ingredient', count);
  return updated;
}

export function objectivesComplete(objectives: readonly EngineObjective[]): boolean {
  return objectives.every(objective => objective.current >= objective.target);
}

function increment(objectives: EngineObjective[], kind: EngineObjective['kind'], amount: number, color?: string): void {
  for (const objective of objectives) if (objective.kind === kind && (!color || objective.color === color)) {
    objective.current = Math.min(objective.target, objective.current + amount);
  }
}
