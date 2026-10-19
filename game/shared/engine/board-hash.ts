import type { BoardState } from './engine-types';

export function boardHash(board: BoardState): string {
  let hash = 2_166_136_261;
  const update = (value: string) => {
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
  };
  update(`${board.rows}:${board.cols}:${board.rngState}:${board.nextCandyId}:${board.shuffleCount}|`);
  board.cells.forEach(row => row.forEach(cell => update([
    cell.playable ? 1 : 0,
    cell.candy ? `${cell.candy.id}:${cell.candy.color}:${cell.candy.special}` : '-',
    cell.blocker ? `${cell.blocker.kind}:${cell.blocker.hp}` : '-',
    cell.overlay ? `${cell.overlay.kind}:${cell.overlay.hp}` : '-',
    cell.occupant?.kind ?? '-',
  ].join('/'))));
  return (hash >>> 0).toString(16).padStart(8, '0');
}
