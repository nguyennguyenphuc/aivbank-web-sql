import { describe, expect, it } from 'vitest';
import {
  applyMove, boardHash, createBoard, findPossibleMove, replayMoves, resolveSpecialSwap,
  type BoardConfig, type EngineObjective,
} from '../../shared/engine';

const config: BoardConfig = {
  rows: 8, cols: 8, seed: 912_345,
  colors: ['red', 'orange', 'yellow', 'green', 'blue'],
  ice: [{ row: 0, col: 0, hp: 1 }],
  chocolate: [{ row: 7, col: 7, hp: 1 }],
};
const objectives: EngineObjective[] = [
  { kind: 'score', current: 0, target: 10_000 },
  { kind: 'collect-color', color: 'red', current: 0, target: 20 },
];

describe('turn and replay parity', () => {
  it('replays a move log to the exact final hash and score', () => {
    const initial = createBoard(config);
    const move = findPossibleMove(initial)!;
    const turn = applyMove(initial, move, objectives, config.colors, 0);
    expect(turn.accepted).toBe(true);
    expect(turn.record).toBeDefined();
    const replay = replayMoves(config, objectives, [turn.record!]);
    expect(replay).toMatchObject({ valid: true, score: turn.scoreDelta, acceptedMoves: 1 });
    expect(replay.finalBoardHash).toBe(boardHash(turn.board));
  });

  it('rejects tampered replay hashes', () => {
    const initial = createBoard(config);
    const turn = applyMove(initial, findPossibleMove(initial)!, objectives, config.colors, 0);
    const replay = replayMoves(config, objectives, [{ ...turn.record!, boardHashAfter: '00000000' }]);
    expect(replay.valid).toBe(false);
    expect(replay.reason).toMatch(/after move 0/);
  });

  it('resolves every special-to-special family deterministically', () => {
    const board = createBoard(config);
    const first = board.cells[2][2].candy!;
    const second = board.cells[2][3].candy!;
    first.special = 'rainbow';
    second.special = 'rainbow';
    expect(resolveSpecialSwap(board, { row: 2, col: 2 }, { row: 2, col: 3 })).toHaveLength(64);
    first.special = 'wrapped';
    second.special = 'wrapped';
    expect(resolveSpecialSwap(board, { row: 2, col: 2 }, { row: 2, col: 3 })!.length).toBeGreaterThanOrEqual(20);
    first.special = 'striped-h';
    second.special = 'striped-v';
    expect(resolveSpecialSwap(board, { row: 2, col: 2 }, { row: 2, col: 3 })!.length).toBe(15);
    first.special = 'rainbow';
    second.special = 'striped-h';
    expect(resolveSpecialSwap(board, { row: 2, col: 2 }, { row: 2, col: 3 })!.length).toBeGreaterThan(15);
    first.special = 'wrapped';
    second.special = 'striped-v';
    expect(resolveSpecialSwap(board, { row: 2, col: 2 }, { row: 2, col: 3 })!.length).toBeGreaterThan(30);
  });
});
