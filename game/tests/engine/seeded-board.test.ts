import { describe, expect, it } from 'vitest';
import { boardHash, createBoard, findMatches, findPossibleMove } from '../../shared/engine';

describe('seeded layered board', () => {
  const config = {
    rows: 8, cols: 8, seed: 42,
    colors: ['red', 'yellow', 'green', 'blue'] as const,
    blocked: [{ row: 4, col: 4 }],
    ice: [{ row: 2, col: 2, hp: 2 }],
    chocolate: [{ row: 6, col: 3 }],
    ingredients: [{ row: 0, col: 2 }],
  };

  it('reproduces the same playable board without initial matches', () => {
    const first = createBoard(config);
    const second = createBoard(config);
    expect(boardHash(first)).toBe(boardHash(second));
    expect(findMatches(first).cells).toHaveLength(0);
    expect(findPossibleMove(first)).not.toBeNull();
  });

  it('keeps fixed mechanics in independent layers', () => {
    const board = createBoard(config);
    expect(board.cells[4][4]).toMatchObject({ playable: false, candy: null });
    expect(board.cells[2][2]).toMatchObject({ overlay: { kind: 'ice', hp: 2 } });
    expect(board.cells[6][3]).toMatchObject({ blocker: { kind: 'chocolate', hp: 1 }, candy: null });
    expect(board.cells[0][2]).toMatchObject({ occupant: { kind: 'ingredient' } });
  });

  it('keeps the generation invariants across a seed sample', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const board = createBoard({ rows: 8, cols: 8, seed, colors: config.colors });
      expect(findMatches(board).cells, `seed ${seed}`).toHaveLength(0);
      expect(findPossibleMove(board), `seed ${seed}`).not.toBeNull();
    }
  });
});
