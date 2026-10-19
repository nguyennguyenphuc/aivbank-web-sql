import { describe, expect, it } from 'vitest';
import {
  applyGravityAndRefill, clearCells, cloneBoard, createBoard, findMatches, findPossibleMove,
  shuffleDeadBoard, type BoardState, type CandyColor, type EngineObjective,
} from '../../shared/engine';

const colors = ['red', 'yellow', 'green', 'blue'] as const;

describe('layered mechanics', () => {
  it('applies gravity without moving blocker or overlay layers', () => {
    const original = createBoard({
      rows: 6, cols: 6, seed: 7, colors,
      chocolate: [{ row: 3, col: 2 }], ice: [{ row: 4, col: 1, hp: 2 }],
    });
    const board = cloneBoard(original);
    board.cells[5][1].candy = null;
    const result = applyGravityAndRefill(board, colors).board;
    expect(result.cells[3][2].blocker).toEqual({ kind: 'chocolate', hp: 1 });
    expect(result.cells[4][1].overlay).toEqual({ kind: 'ice', hp: 2 });
    expect(result.cells[5][1].candy).not.toBeNull();
  });

  it('damages overlays and adjacent blockers while updating objectives', () => {
    const board = createBoard({
      rows: 6, cols: 6, seed: 8, colors,
      ice: [{ row: 2, col: 2 }], chocolate: [{ row: 2, col: 3 }],
    });
    const objectives: EngineObjective[] = [
      { kind: 'score', target: 1_000, current: 0 },
      { kind: 'clear-ice', target: 1, current: 0 },
      { kind: 'clear-chocolate', target: 1, current: 0 },
    ];
    const result = clearCells(board, [{ row: 2, col: 2 }], objectives, 180);
    expect(result.board.cells[2][2].overlay).toBeNull();
    expect(result.board.cells[2][3].blocker).toBeNull();
    expect(result.objectives.map(objective => objective.current)).toEqual([180, 1, 1]);
  });

  it('detects and deterministically shuffles a dead settled board', () => {
    const dead = findDeadBoard();
    expect(findMatches(dead).cells).toHaveLength(0);
    expect(findPossibleMove(dead)).toBeNull();
    const first = shuffleDeadBoard(dead, colors);
    const second = shuffleDeadBoard(dead, colors);
    expect(first).toEqual(second);
    expect(findMatches(first).cells).toHaveLength(0);
    expect(findPossibleMove(first)).not.toBeNull();
  });
});

function findDeadBoard(): BoardState {
  const board = createBoard({ rows: 3, cols: 3, seed: 99, colors });
  const palette: CandyColor[] = ['red', 'yellow', 'green'];
  for (let mask = 0; mask < 3 ** 9; mask++) {
    let value = mask;
    for (let index = 0; index < 9; index++) {
      board.cells[Math.floor(index / 3)][index % 3].candy!.color = palette[value % 3];
      value = Math.floor(value / 3);
    }
    if (!findMatches(board).cells.length && !findPossibleMove(board)) return cloneBoard(board);
  }
  throw new Error('Expected a dead 3x3 board fixture');
}
