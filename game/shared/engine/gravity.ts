import { cloneBoard } from './board-state';
import type { BoardState, CandyColor, Coordinate } from './engine-types';
import { createSeededRandom } from './seeded-rng';

export interface GravityResult { board: BoardState; droppedIngredients: number }

export function applyGravityAndRefill(input: BoardState, colors: readonly CandyColor[]): GravityResult {
  const board = cloneBoard(input);
  const random = createSeededRandom(board.rngState);
  let droppedIngredients = 0;
  for (let col = 0; col < board.cols; col++) {
    const segments = playableSegments(board, col);
    for (const segment of segments) {
      const payload = segment.map(row => board.cells[row][col])
        .filter(cell => !cell.blocker && (cell.candy || cell.occupant))
        .map(cell => ({ candy: cell.candy, occupant: cell.occupant }));
      for (let index = segment.length - 1; index >= 0; index--) {
        const row = segment[index];
        const cell = board.cells[row][col];
        if (cell.blocker) continue;
        const item = payload.pop();
        cell.candy = item?.candy ?? null;
        cell.occupant = item?.occupant ?? null;
        if (cell.occupant && cell.spawn.ingredientExit) {
          droppedIngredients++;
          cell.occupant = null;
          cell.candy = null;
        }
      }
      for (const row of segment) {
        const cell = board.cells[row][col];
        if (!cell.blocker && !cell.candy) {
          cell.candy = { id: `c${board.nextCandyId++}`, color: colors[random.integer(colors.length)], special: 'none' };
        }
      }
    }
  }
  board.rngState = random.state;
  return { board, droppedIngredients };
}

function playableSegments(board: BoardState, col: number): number[][] {
  const segments: number[][] = [];
  let current: number[] = [];
  for (let row = 0; row < board.rows; row++) {
    if (!board.cells[row][col].playable) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push(row);
  }
  if (current.length) segments.push(current);
  return segments;
}

export function adjacentPositions(board: BoardState, position: Coordinate): Coordinate[] {
  return [[-1, 0], [1, 0], [0, -1], [0, 1]]
    .map(([dr, dc]) => ({ row: position.row + dr, col: position.col + dc }))
    .filter(next => Boolean(board.cells[next.row]?.[next.col]?.playable));
}
