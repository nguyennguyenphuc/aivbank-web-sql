import { boardHash } from './board-hash';
import { cloneBoard } from './board-state';
import { applyGravityAndRefill } from './gravity';
import type { BoardState, CandyColor, Coordinate, EngineMove, EngineObjective, TurnResult } from './engine-types';
import { findMatches } from './match-finder';
import { findPossibleMove, shuffleDeadBoard, swapCandies, validateMove } from './move-validator';
import { addDroppedIngredients, clearCells } from './objective-tracker';
import { expandSpecials, resolveSpecialSwap } from './special-resolver';

export function applyMove(
  input: BoardState,
  move: EngineMove,
  objectives: readonly EngineObjective[],
  colors: readonly CandyColor[],
  index = 0,
): TurnResult {
  const before = boardHash(input);
  const reason = validateMove(input, move);
  if (reason) return { accepted: false, board: cloneBoard(input), objectives: objectives.map(item => ({ ...item })), scoreDelta: 0, cascades: 0, shuffled: false, reason };
  let board = cloneBoard(input);
  const combo = resolveSpecialSwap(board, move.from, move.to);
  swapCandies(board, move);
  let pending = combo;
  let updated = objectives.map(item => ({ ...item }));
  let scoreDelta = 0;
  let cascades = 0;

  while (cascades < 100) {
    const matches = pending ? null : findMatches(board, cascades === 0 ? move.to : undefined);
    const matched = pending ?? matches!.cells;
    if (!matched.length) break;
    const specials = pending ? [] : matches!.specials;
    const expanded = expandSpecials(board, matched);
    const score = expanded.length * 60 * (cascades + 1);
    const cleared = clearCells(board, expanded, updated, score);
    board = cleared.board;
    updated = cleared.objectives;
    specials.forEach(special => {
      const cell = board.cells[special.row][special.col];
      if (!cell.blocker) cell.candy = { id: `c${board.nextCandyId++}`, color: special.color, special: special.special };
    });
    const gravity = applyGravityAndRefill(board, colors);
    board = gravity.board;
    updated = addDroppedIngredients(updated, gravity.droppedIngredients);
    scoreDelta += score;
    cascades++;
    pending = null;
  }
  let shuffled = false;
  if (!findPossibleMove(board)) {
    board = shuffleDeadBoard(board, colors);
    shuffled = true;
  }
  const after = boardHash(board);
  return {
    accepted: true, board, objectives: updated, scoreDelta, cascades, shuffled,
    record: { index, ...move, boardHashBefore: before, boardHashAfter: after },
  };
}

export function clearCoordinates(board: BoardState, positions: readonly Coordinate[]): BoardState {
  const copy = cloneBoard(board);
  positions.forEach(position => { if (copy.cells[position.row]?.[position.col]) copy.cells[position.row][position.col].candy = null; });
  return copy;
}
