import type { BoardState, Coordinate, SpecialType } from './engine-types';

const key = ({ row, col }: Coordinate): string => `${row},${col}`;
const parse = (value: string): Coordinate => {
  const [row, col] = value.split(',').map(Number);
  return { row, col };
};

export function resolveSpecialSwap(board: BoardState, first: Coordinate, second: Coordinate): Coordinate[] | null {
  const a = board.cells[first.row]?.[first.col]?.candy;
  const b = board.cells[second.row]?.[second.col]?.candy;
  if (!a || !b || (a.special === 'none' && b.special === 'none')) return null;
  const affected = new Set<string>();
  const add = (position: Coordinate) => affected.add(key(position));

  if (a.special === 'rainbow' && b.special === 'rainbow') {
    board.cells.forEach((row, rowIndex) => row.forEach((cell, col) => cell.playable && add({ row: rowIndex, col })));
  } else if (a.special === 'rainbow' || b.special === 'rainbow') {
    const other = a.special === 'rainbow' ? b : a;
    board.cells.forEach((row, rowIndex) => row.forEach((cell, col) => {
      if (cell.candy?.color !== other.color) return;
      add({ row: rowIndex, col });
      if (other.special.startsWith('striped')) addCross(board, affected, rowIndex, col);
      if (other.special === 'wrapped') addSquare(board, affected, rowIndex, col, 1);
    }));
  } else if (isStriped(a.special) && isStriped(b.special)) {
    addCross(board, affected, second.row, second.col);
  } else if ((isStriped(a.special) && b.special === 'wrapped') || (isStriped(b.special) && a.special === 'wrapped')) {
    for (let offset = -1; offset <= 1; offset++) {
      addRow(board, affected, second.row + offset);
      addColumn(board, affected, second.col + offset);
    }
  } else if (a.special === 'wrapped' && b.special === 'wrapped') {
    addSquare(board, affected, second.row, second.col, 2);
  } else {
    return expandSpecials(board, [first, second]);
  }
  return expandSpecials(board, [...affected].map(parse));
}

export function expandSpecials(board: BoardState, initial: readonly Coordinate[]): Coordinate[] {
  const affected = new Set<string>();
  const queued = new Set<string>();
  const queue = [...initial];
  initial.forEach(position => queued.add(key(position)));
  while (queue.length) {
    const position = queue.shift()!;
    affected.add(key(position));
    const candy = board.cells[position.row]?.[position.col]?.candy;
    if (!candy || candy.special === 'none') continue;
    const before = new Set(affected);
    if (candy.special === 'striped-h') addRow(board, affected, position.row);
    if (candy.special === 'striped-v') addColumn(board, affected, position.col);
    if (candy.special === 'wrapped') addSquare(board, affected, position.row, position.col, 1);
    if (candy.special === 'rainbow') board.cells.forEach((row, rowIndex) => row.forEach((cell, col) => {
      if (cell.candy?.color === candy.color) affected.add(key({ row: rowIndex, col }));
    }));
    for (const added of affected) if (!before.has(added) && !queued.has(added)) {
      queue.push(parse(added));
      queued.add(added);
    }
  }
  return [...affected].map(parse).sort((a, b) => a.row - b.row || a.col - b.col);
}

const isStriped = (special: SpecialType): boolean => special === 'striped-h' || special === 'striped-v';
function addRow(board: BoardState, set: Set<string>, row: number): void {
  if (row < 0 || row >= board.rows) return;
  for (let col = 0; col < board.cols; col++) if (board.cells[row][col].playable) set.add(key({ row, col }));
}
function addColumn(board: BoardState, set: Set<string>, col: number): void {
  if (col < 0 || col >= board.cols) return;
  for (let row = 0; row < board.rows; row++) if (board.cells[row][col].playable) set.add(key({ row, col }));
}
function addCross(board: BoardState, set: Set<string>, row: number, col: number): void {
  addRow(board, set, row);
  addColumn(board, set, col);
}
function addSquare(board: BoardState, set: Set<string>, row: number, col: number, radius: number): void {
  for (let dr = -radius; dr <= radius; dr++) for (let dc = -radius; dc <= radius; dc++) {
    const cell = board.cells[row + dr]?.[col + dc];
    if (cell?.playable) set.add(key({ row: row + dr, col: col + dc }));
  }
}
