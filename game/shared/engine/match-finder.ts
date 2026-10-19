import type { BoardState, CandyColor, Coordinate, MatchRun, MatchSet, SpecialType } from './engine-types';

const cellKey = ({ row, col }: Coordinate): string => `${row},${col}`;

export function findMatches(board: BoardState, preferred?: Coordinate): MatchSet {
  const runs = [...scan(board, 'horizontal'), ...scan(board, 'vertical')];
  const unique = new Map<string, Coordinate>();
  runs.forEach(run => run.cells.forEach(cell => unique.set(cellKey(cell), cell)));
  const specials = createSpecials(runs, preferred);
  return { cells: [...unique.values()], runs, specials };
}

function scan(board: BoardState, axis: 'horizontal' | 'vertical'): MatchRun[] {
  const outer = axis === 'horizontal' ? board.rows : board.cols;
  const inner = axis === 'horizontal' ? board.cols : board.rows;
  const runs: MatchRun[] = [];
  for (let a = 0; a < outer; a++) {
    let start = 0;
    while (start < inner) {
      const position = axis === 'horizontal' ? { row: a, col: start } : { row: start, col: a };
      const color = matchableColor(board, position);
      let end = start + 1;
      while (color && end < inner) {
        const next = axis === 'horizontal' ? { row: a, col: end } : { row: end, col: a };
        if (matchableColor(board, next) !== color) break;
        end++;
      }
      if (color && end - start >= 3) {
        const cells = Array.from({ length: end - start }, (_, offset) => axis === 'horizontal'
          ? { row: a, col: start + offset } : { row: start + offset, col: a });
        runs.push({ cells, color, axis });
      }
      start = Math.max(end, start + 1);
    }
  }
  return runs;
}

function matchableColor(board: BoardState, position: Coordinate): CandyColor | undefined {
  const cell = board.cells[position.row]?.[position.col];
  return cell?.playable && !cell.blocker && !cell.occupant ? cell.candy?.color : undefined;
}

function createSpecials(runs: MatchRun[], preferred?: Coordinate): MatchSet['specials'] {
  const result = new Map<string, Coordinate & { color: CandyColor; special: SpecialType }>();
  for (const horizontal of runs.filter(run => run.axis === 'horizontal')) {
    const vertical = runs.find(run => run.axis === 'vertical' && run.color === horizontal.color
      && run.cells.some(cell => horizontal.cells.some(other => cellKey(cell) === cellKey(other))));
    if (vertical) {
      const intersection = horizontal.cells.find(cell => vertical.cells.some(other => cellKey(cell) === cellKey(other)))!;
      result.set(cellKey(intersection), { ...intersection, color: horizontal.color, special: 'wrapped' });
    }
  }
  for (const run of runs) {
    const chosen = preferred && run.cells.some(cell => cellKey(cell) === cellKey(preferred))
      ? preferred : run.cells[Math.floor(run.cells.length / 2)];
    const special: SpecialType | null = run.cells.length >= 5 ? 'rainbow'
      : run.cells.length === 4 ? (run.axis === 'horizontal' ? 'striped-v' : 'striped-h') : null;
    if (special && !result.has(cellKey(chosen))) result.set(cellKey(chosen), { ...chosen, color: run.color, special });
  }
  return [...result.values()];
}
