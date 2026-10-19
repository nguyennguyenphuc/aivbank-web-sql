import { cloneBoard, isInside, isSwappable } from './board-state';
import type { BoardState, Candy, CandyColor, Coordinate, EngineMove } from './engine-types';
import { findMatches } from './match-finder';
import { createSeededRandom, shuffleSeeded } from './seeded-rng';

export function areAdjacent(first: Coordinate, second: Coordinate): boolean {
  return Math.abs(first.row - second.row) + Math.abs(first.col - second.col) === 1;
}

export function swapCandies(board: BoardState, move: EngineMove): void {
  const first = board.cells[move.from.row][move.from.col];
  const second = board.cells[move.to.row][move.to.col];
  [first.candy, second.candy] = [second.candy, first.candy];
  [first.occupant, second.occupant] = [second.occupant, first.occupant];
}

export function validateMove(board: BoardState, move: EngineMove): 'not-adjacent' | 'blocked' | 'no-match' | null {
  if (!areAdjacent(move.from, move.to)) return 'not-adjacent';
  if (!isInside(board, move.from) || !isInside(board, move.to)) return 'blocked';
  const first = board.cells[move.from.row][move.from.col];
  const second = board.cells[move.to.row][move.to.col];
  if (!isSwappable(first) || !isSwappable(second) || first.occupant || second.occupant) return 'blocked';
  const firstSpecial = first.candy!.special;
  const secondSpecial = second.candy!.special;
  if ((firstSpecial !== 'none' && secondSpecial !== 'none') || firstSpecial === 'rainbow' || secondSpecial === 'rainbow') return null;
  const copy = cloneBoard(board);
  swapCandies(copy, move);
  return findMatches(copy, move.to).cells.length ? null : 'no-match';
}

export function findPossibleMove(board: BoardState): EngineMove | null {
  for (let row = 0; row < board.rows; row++) for (let col = 0; col < board.cols; col++) {
    for (const to of [{ row, col: col + 1 }, { row: row + 1, col }]) {
      const move = { from: { row, col }, to };
      if (isInside(board, to) && validateMove(board, move) === null) return move;
    }
  }
  return null;
}

export function shuffleDeadBoard(input: BoardState, colors: readonly CandyColor[]): BoardState {
  let board = cloneBoard(input);
  const random = createSeededRandom(board.rngState ^ (board.shuffleCount + 1));
  const positions: Coordinate[] = [];
  const candies: Candy[] = [];
  board.cells.forEach((row, rowIndex) => row.forEach((cell, col) => {
    if (isSwappable(cell) && !cell.occupant) {
      positions.push({ row: rowIndex, col });
      candies.push(cell.candy!);
    }
  }));
  for (let attempt = 0; attempt < 32; attempt++) {
    const pool = shuffleSeeded(candies, random);
    positions.forEach((position, index) => { board.cells[position.row][position.col].candy = pool[index]; });
    if (!findMatches(board).cells.length && findPossibleMove(board)) {
      board.rngState = random.state;
      board.shuffleCount++;
      return board;
    }
  }
  for (let attempt = 0; attempt < 256; attempt++) {
    positions.forEach(position => {
      const cell = board.cells[position.row][position.col];
      cell.candy = { id: `c${board.nextCandyId++}`, color: colors[random.integer(colors.length)], special: 'none' };
    });
    if (!findMatches(board).cells.length && findPossibleMove(board)) {
      board.rngState = random.state;
      board.shuffleCount++;
      return board;
    }
  }
  throw new Error('Unable to produce a settled playable shuffle');
}
