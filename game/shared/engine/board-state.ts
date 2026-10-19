import type { BoardCell, BoardConfig, BoardState, CandyColor, Coordinate } from './engine-types';
import { createSeededRandom } from './seeded-rng';

const key = ({ row, col }: Coordinate): string => `${row},${col}`;

export function cloneBoard(board: BoardState): BoardState {
  return {
    ...board,
    cells: board.cells.map(row => row.map(cell => ({
      ...cell,
      candy: cell.candy && { ...cell.candy }, blocker: cell.blocker && { ...cell.blocker },
      overlay: cell.overlay && { ...cell.overlay }, occupant: cell.occupant && { ...cell.occupant },
      spawn: { ...cell.spawn },
    }))),
  };
}

export function isInside(board: BoardState, position: Coordinate): boolean {
  return position.row >= 0 && position.row < board.rows && position.col >= 0 && position.col < board.cols;
}

export function isSwappable(cell: BoardCell): boolean {
  return cell.playable && cell.blocker === null && cell.candy !== null;
}

export function createBoard(config: BoardConfig): BoardState {
  validateConfig(config);
  const blocked = new Set(config.blocked?.map(key));
  const ice = new Map(config.ice?.map(item => [key(item), item.hp ?? 1]));
  const chocolate = new Map(config.chocolate?.map(item => [key(item), item.hp ?? 1]));
  const ingredients = new Set(config.ingredients?.map(key));
  const exits = new Set(config.ingredientExits?.map(key));
  const random = createSeededRandom(config.seed);
  let nextCandyId = 0;
  const cells: BoardCell[][] = [];

  for (let row = 0; row < config.rows; row++) {
    cells[row] = [];
    for (let col = 0; col < config.cols; col++) {
      const position = { row, col };
      const blockedCell = blocked.has(key(position));
      const forbidden = blockedCell || chocolate.has(key(position)) ? [] : forbiddenColors(cells, row, col);
      const choices = config.colors.filter(color => !forbidden.includes(color));
      const color = choices[random.integer(choices.length || config.colors.length)] ?? config.colors[0];
      cells[row][col] = {
        playable: !blockedCell,
        candy: blockedCell || chocolate.has(key(position)) ? null : { id: `c${nextCandyId++}`, color, special: 'none' },
        blocker: chocolate.has(key(position)) ? { kind: 'chocolate', hp: chocolate.get(key(position))! } : null,
        overlay: ice.has(key(position)) ? { kind: 'ice', hp: ice.get(key(position))! } : null,
        occupant: ingredients.has(key(position)) ? { kind: 'ingredient' } : null,
        spawn: { enabled: row === 0 && !blockedCell, ingredientExit: exits.has(key(position)) || row === config.rows - 1 },
      };
    }
  }
  const board = { rows: config.rows, cols: config.cols, cells, seed: config.seed >>> 0, rngState: random.state, nextCandyId, shuffleCount: 0 };
  if (!ensureOpeningMove(board, config.colors)) throw new Error('Board mask cannot support a legal opening move');
  return board;
}

function forbiddenColors(cells: BoardCell[][], row: number, col: number): CandyColor[] {
  const forbidden: CandyColor[] = [];
  const left = cells[row]?.[col - 1]?.candy?.color;
  if (left && left === cells[row]?.[col - 2]?.candy?.color) forbidden.push(left);
  const up = cells[row - 1]?.[col]?.candy?.color;
  if (up && up === cells[row - 2]?.[col]?.candy?.color) forbidden.push(up);
  return forbidden;
}

function validateConfig(config: BoardConfig): void {
  if (!Number.isInteger(config.rows) || !Number.isInteger(config.cols) || config.rows < 3 || config.cols < 3) {
    throw new Error('Board dimensions must be integers of at least 3');
  }
  if (config.colors.length < 3) throw new Error('At least three colors are required');
}

function ensureOpeningMove(board: BoardState, colors: readonly CandyColor[]): boolean {
  for (let row = 0; row < board.rows - 1; row++) for (let col = 0; col < board.cols - 2; col++) {
    const area = [
      board.cells[row][col], board.cells[row][col + 1], board.cells[row][col + 2],
      board.cells[row + 1][col], board.cells[row + 1][col + 1], board.cells[row + 1][col + 2],
    ];
    if (area.some(cell => !isSwappable(cell) || cell.occupant)) continue;
    const original = area.map(cell => cell.candy!.color);
    for (const a of colors) for (const b of colors) for (const c of colors) {
      if (a === b || a === c || b === c) continue;
      [area[0].candy!.color, area[1].candy!.color, area[2].candy!.color] = [a, b, a];
      [area[3].candy!.color, area[4].candy!.color, area[5].candy!.color] = [c, a, c];
      if (!hasNaturalMatch(board)) return true;
    }
    area.forEach((cell, index) => { cell.candy!.color = original[index]; });
  }
  return false;
}

function hasNaturalMatch(board: BoardState): boolean {
  for (let row = 0; row < board.rows; row++) for (let col = 0; col < board.cols; col++) {
    const color = board.cells[row][col].occupant ? undefined : board.cells[row][col].candy?.color;
    if (!color) continue;
    if (color === board.cells[row]?.[col + 1]?.candy?.color && color === board.cells[row]?.[col + 2]?.candy?.color) return true;
    if (color === board.cells[row + 1]?.[col]?.candy?.color && color === board.cells[row + 2]?.[col]?.candy?.color) return true;
  }
  return false;
}
