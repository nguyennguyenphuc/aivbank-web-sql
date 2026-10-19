import { CandyColor, CellTile, LevelConfig, MatchResult, SpecialType } from '../types/game';
import { createSeededRandom } from '../../shared/engine/seeded-rng';

// Unique ID generator for tiles
let idCounter = 0;
export function generateTileId(): string {
  idCounter++;
  return `tile_${idCounter}`;
}

export const CANDY_COLORS: CandyColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

// Create an initial balanced board for a level
export function createInitialBoard(level: LevelConfig, seed = level.seed ?? level.id): CellTile[][] {
  const { rows, cols, allowedColors, initialIce, initialChocolate, initialIngredients, blockedCells } = level;
  const board: CellTile[][] = [];
  const random = createSeededRandom(seed);
  let boardTileId = 0;

  const blockedMap = new Set(blockedCells?.map(b => `${b.row},${b.col}`) || []);
  const iceMap = new Map<string, number>();
  initialIce?.forEach(i => iceMap.set(`${i.row},${i.col}`, i.level));

  const chocoSet = new Set(initialChocolate?.map(c => `${c.row},${c.col}`) || []);
  const ingredientSet = new Set(initialIngredients?.map(ing => `${ing.row},${ing.col}`) || []);

  for (let r = 0; r < rows; r++) {
    const row: CellTile[] = [];
    for (let c = 0; c < cols; c++) {
      const key = `${r},${c}`;
      if (blockedMap.has(key)) {
        // Blocked empty void
        row.push({
          id: `tile_${seed}_${boardTileId++}`,
          row: r,
          col: c,
          color: allowedColors[0],
          special: 'none',
          iceLevel: 0,
          hasChocolate: false,
          isIngredient: false,
        });
        continue;
      }

      // Pick color that doesn't immediately create a 3-match with already placed tiles
      const forbiddenColors: CandyColor[] = [];
      if (c >= 2 && row[c - 1]?.color === row[c - 2]?.color) {
        forbiddenColors.push(row[c - 1].color);
      }
      if (r >= 2 && board[r - 1]?.[c]?.color === board[r - 2]?.[c]?.color) {
        forbiddenColors.push(board[r - 1][c].color);
      }

      const validColors = allowedColors.filter(col => !forbiddenColors.includes(col));
      const chosenColor = validColors.length > 0
        ? validColors[random.integer(validColors.length)]
        : allowedColors[random.integer(allowedColors.length)];

      const isChoco = chocoSet.has(key);
      const isIng = ingredientSet.has(key);
      const iceLvl = iceMap.get(key) || 0;

      row.push({
        id: `tile_${seed}_${boardTileId++}`,
        row: r,
        col: c,
        color: chosenColor,
        special: 'none',
        iceLevel: iceLvl,
        hasChocolate: isChoco,
        isIngredient: isIng,
      });
    }
    board.push(row);
  }

  return board;
}

// Find all natural matches in the board
export function findMatches(board: CellTile[][], allowedColors: CandyColor[]): MatchResult {
  const rows = board.length;
  const cols = board[0].length;
  const matchedSet = new Set<string>();
  const horizontalRuns: { row: number; startCol: number; endCol: number; color: CandyColor }[] = [];
  const verticalRuns: { col: number; startRow: number; endRow: number; color: CandyColor }[] = [];

  // 1. Horizontal check
  for (let r = 0; r < rows; r++) {
    let matchLen = 1;
    for (let c = 0; c < cols; c++) {
      const curr = board[r][c];
      const next = c + 1 < cols ? board[r][c + 1] : null;

      if (
        curr &&
        !curr.hasChocolate &&
        !curr.isIngredient &&
        next &&
        !next.hasChocolate &&
        !next.isIngredient &&
        curr.color === next.color
      ) {
        matchLen++;
      } else {
        if (matchLen >= 3) {
          horizontalRuns.push({
            row: r,
            startCol: c - matchLen + 1,
            endCol: c,
            color: board[r][c].color,
          });
          for (let k = c - matchLen + 1; k <= c; k++) {
            matchedSet.add(`${r},${k}`);
          }
        }
        matchLen = 1;
      }
    }
  }

  // 2. Vertical check
  for (let c = 0; c < cols; c++) {
    let matchLen = 1;
    for (let r = 0; r < rows; r++) {
      const curr = board[r][c];
      const next = r + 1 < rows ? board[r + 1][c] : null;

      if (
        curr &&
        !curr.hasChocolate &&
        !curr.isIngredient &&
        next &&
        !next.hasChocolate &&
        !next.isIngredient &&
        curr.color === next.color
      ) {
        matchLen++;
      } else {
        if (matchLen >= 3) {
          verticalRuns.push({
            col: c,
            startRow: r - matchLen + 1,
            endRow: r,
            color: board[r][c].color,
          });
          for (let k = r - matchLen + 1; k <= r; k++) {
            matchedSet.add(`${k},${c}`);
          }
        }
        matchLen = 1;
      }
    }
  }

  // 3. Determine Special Candies creation
  const createdSpecials: { row: number; col: number; special: SpecialType; color: CandyColor }[] = [];

  // Check 5-in-a-row (Rainbow Candy)
  horizontalRuns.forEach(h => {
    const len = h.endCol - h.startCol + 1;
    if (len >= 5) {
      const mid = Math.floor((h.startCol + h.endCol) / 2);
      createdSpecials.push({ row: h.row, col: mid, special: 'rainbow_candy', color: h.color });
    }
  });

  verticalRuns.forEach(v => {
    const len = v.endRow - v.startRow + 1;
    if (len >= 5) {
      const mid = Math.floor((v.startRow + v.endRow) / 2);
      // Avoid duplicate specials at same cell
      if (!createdSpecials.some(s => s.row === mid && s.col === v.col)) {
        createdSpecials.push({ row: mid, col: v.col, special: 'rainbow_candy', color: v.color });
      }
    }
  });

  // Check T/L-shaped matches (5 candies forming an intersection) -> Wrapped Bomb
  horizontalRuns.forEach(h => {
    if (h.endCol - h.startCol + 1 < 5) {
      verticalRuns.forEach(v => {
        if (v.endRow - v.startRow + 1 < 5 && h.color === v.color) {
          if (v.col >= h.startCol && v.col <= h.endCol && h.row >= v.startRow && h.row <= v.endRow) {
            // Intersection found
            if (!createdSpecials.some(s => s.row === h.row && s.col === v.col)) {
              createdSpecials.push({ row: h.row, col: v.col, special: 'wrapped_bomb', color: h.color });
            }
          }
        }
      });
    }
  });

  // Check 4-in-a-row (Striped candies)
  horizontalRuns.forEach(h => {
    const len = h.endCol - h.startCol + 1;
    if (len === 4) {
      const mid = Math.floor((h.startCol + h.endCol) / 2);
      if (!createdSpecials.some(s => s.row === h.row && s.col === mid)) {
        createdSpecials.push({ row: h.row, col: mid, special: 'striped_v', color: h.color });
      }
    }
  });

  verticalRuns.forEach(v => {
    const len = v.endRow - v.startRow + 1;
    if (len === 4) {
      const mid = Math.floor((v.startRow + v.endRow) / 2);
      if (!createdSpecials.some(s => s.row === mid && s.col === v.col)) {
        createdSpecials.push({ row: mid, col: v.col, special: 'striped_h', color: v.color });
      }
    }
  });

  const matches = Array.from(matchedSet).map(s => {
    const [r, c] = s.split(',').map(Number);
    return { row: r, col: c };
  });

  return {
    matches,
    createdSpecials,
    comboMultiplier: 1,
  };
}

// Calculate the full explosion set when special candies trigger
export function getSpecialExplosions(
  board: CellTile[][],
  triggerCells: { row: number; col: number; special: SpecialType; color: CandyColor }[]
): { row: number; col: number }[] {
  const rows = board.length;
  const cols = board[0].length;
  const explodedSet = new Set<string>();
  const queue = [...triggerCells];

  while (queue.length > 0) {
    const item = queue.shift()!;
    const key = `${item.row},${item.col}`;
    if (explodedSet.has(key)) continue;
    explodedSet.add(key);

    if (item.special === 'striped_h') {
      // Clear entire row
      for (let c = 0; c < cols; c++) {
        const cell = board[item.row][c];
        explodedSet.add(`${item.row},${c}`);
        if (cell && cell.special !== 'none' && !explodedSet.has(`${item.row},${c}`)) {
          queue.push({ row: item.row, col: c, special: cell.special, color: cell.color });
        }
      }
    } else if (item.special === 'striped_v') {
      // Clear entire column
      for (let r = 0; r < rows; r++) {
        const cell = board[r][item.col];
        explodedSet.add(`${r},${item.col}`);
        if (cell && cell.special !== 'none' && !explodedSet.has(`${r},${item.col}`)) {
          queue.push({ row: r, col: item.col, special: cell.special, color: cell.color });
        }
      }
    } else if (item.special === 'wrapped_bomb') {
      // 3x3 surrounding
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = item.row + dr;
          const nc = item.col + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
            explodedSet.add(`${nr},${nc}`);
            const cell = board[nr][nc];
            if (cell && cell.special !== 'none' && !explodedSet.has(`${nr},${nc}`)) {
              queue.push({ row: nr, col: nc, special: cell.special, color: cell.color });
            }
          }
        }
      }
    } else if (item.special === 'rainbow_candy') {
      // Pick the most common color on board and wipe all of them
      const colorCounts: Record<string, number> = {};
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cell = board[r][c];
          if (cell && !cell.hasChocolate && !cell.isIngredient) {
            colorCounts[cell.color] = (colorCounts[cell.color] || 0) + 1;
          }
        }
      }
      let targetColor = item.color;
      let maxCnt = 0;
      Object.entries(colorCounts).forEach(([col, cnt]) => {
        if (cnt > maxCnt) {
          maxCnt = cnt;
          targetColor = col as CandyColor;
        }
      });

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (board[r][c]?.color === targetColor) {
            explodedSet.add(`${r},${c}`);
            const cell = board[r][c];
            if (cell && cell.special !== 'none') {
              queue.push({ row: r, col: c, special: cell.special, color: cell.color });
            }
          }
        }
      }
    }
  }

  return Array.from(explodedSet).map(s => {
    const [r, c] = s.split(',').map(Number);
    return { row: r, col: c };
  });
}

// Special Combo resolution when 2 specials are swapped together
export function resolveSpecialSwap(
  tileA: CellTile,
  tileB: CellTile,
  board: CellTile[][]
): { row: number; col: number }[] | null {
  const rows = board.length;
  const cols = board[0].length;
  const isA = tileA.special !== 'none';
  const isB = tileB.special !== 'none';

  if (!isA && !isB) return null;

  const affected = new Set<string>();

  // 1. Rainbow + Rainbow: Complete board wipe!
  if (tileA.special === 'rainbow_candy' && tileB.special === 'rainbow_candy') {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        affected.add(`${r},${c}`);
      }
    }
    return Array.from(affected).map(s => {
      const [r, c] = s.split(',').map(Number);
      return { row: r, col: c };
    });
  }

  // 2. Rainbow + Striped / Bomb: Transform all of that color!
  if (tileA.special === 'rainbow_candy' || tileB.special === 'rainbow_candy') {
    const rainbowTile = tileA.special === 'rainbow_candy' ? tileA : tileB;
    const otherTile = tileA.special === 'rainbow_candy' ? tileB : tileA;
    const targetColor = otherTile.color;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = board[r][c];
        if (cell.color === targetColor || (r === rainbowTile.row && c === rainbowTile.col)) {
          affected.add(`${r},${c}`);
          if (otherTile.special.startsWith('striped')) {
            // Explode row & col for each
            for (let i = 0; i < cols; i++) affected.add(`${r},${i}`);
            for (let j = 0; j < rows; j++) affected.add(`${j},${c}`);
          } else if (otherTile.special === 'wrapped_bomb') {
            // Explode 3x3 for each
            for (let dr = -1; dr <= 1; dr++) {
              for (let dc = -1; dc <= 1; dc++) {
                const nr = r + dr;
                const nc = c + dc;
                if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) affected.add(`${nr},${nc}`);
              }
            }
          }
        }
      }
    }
    return Array.from(affected).map(s => {
      const [r, c] = s.split(',').map(Number);
      return { row: r, col: c };
    });
  }

  // 3. Striped + Striped: Cross Beam (Row + Column)
  if (tileA.special.startsWith('striped') && tileB.special.startsWith('striped')) {
    const r = tileB.row;
    const c = tileB.col;
    for (let i = 0; i < cols; i++) affected.add(`${r},${i}`);
    for (let j = 0; j < rows; j++) affected.add(`${j},${c}`);
    return Array.from(affected).map(s => {
      const [r, c] = s.split(',').map(Number);
      return { row: r, col: c };
    });
  }

  // 4. Striped + Bomb: Giant 3-row & 3-col cross beam!
  if (
    (tileA.special.startsWith('striped') && tileB.special === 'wrapped_bomb') ||
    (tileB.special.startsWith('striped') && tileA.special === 'wrapped_bomb')
  ) {
    const centerR = tileB.row;
    const centerC = tileB.col;
    for (let dr = -1; dr <= 1; dr++) {
      const r = centerR + dr;
      if (r >= 0 && r < rows) {
        for (let c = 0; c < cols; c++) affected.add(`${r},${c}`);
      }
    }
    for (let dc = -1; dc <= 1; dc++) {
      const c = centerC + dc;
      if (c >= 0 && c < cols) {
        for (let r = 0; r < rows; r++) affected.add(`${r},${c}`);
      }
    }
    return Array.from(affected).map(s => {
      const [r, c] = s.split(',').map(Number);
      return { row: r, col: c };
    });
  }

  // 5. Bomb + Bomb: 5x5 massive explosion!
  if (tileA.special === 'wrapped_bomb' && tileB.special === 'wrapped_bomb') {
    const centerR = tileB.row;
    const centerC = tileB.col;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const r = centerR + dr;
        const c = centerC + dc;
        if (r >= 0 && r < rows && c >= 0 && c < cols) {
          affected.add(`${r},${c}`);
        }
      }
    }
    return Array.from(affected).map(s => {
      const [r, c] = s.split(',').map(Number);
      return { row: r, col: c };
    });
  }

  return null;
}

// Check adjacent swap validity for player gesture
export function areNeighbors(r1: number, c1: number, r2: number, c2: number): boolean {
  return Math.abs(r1 - r2) + Math.abs(c1 - c2) === 1;
}

// Find at least one possible valid move for hint system
export function findPossibleMove(board: CellTile[][], allowedColors: CandyColor[]): { from: [number, number]; to: [number, number] } | null {
  const rows = board.length;
  const cols = board[0].length;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (!cell || cell.hasChocolate || cell.isIngredient) continue;

      // Special combos are always valid
      if (cell.special === 'rainbow_candy') {
        const neighbors = [[r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]];
        for (const [nr, nc] of neighbors) {
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !board[nr][nc]?.hasChocolate) {
            return { from: [r, c], to: [nr, nc] };
          }
        }
      }

      // Check right swap
      if (c + 1 < cols && !board[r][c + 1]?.hasChocolate && !board[r][c + 1]?.isIngredient) {
        swapCells(board, r, c, r, c + 1);
        const matchRes = findMatches(board, allowedColors);
        swapCells(board, r, c, r, c + 1); // swap back
        if (matchRes.matches.length >= 3) {
          return { from: [r, c], to: [r, c + 1] };
        }
      }

      // Check down swap
      if (r + 1 < rows && !board[r + 1][c]?.hasChocolate && !board[r + 1][c]?.isIngredient) {
        swapCells(board, r, c, r + 1, c);
        const matchRes = findMatches(board, allowedColors);
        swapCells(board, r, c, r + 1, c); // swap back
        if (matchRes.matches.length >= 3) {
          return { from: [r, c], to: [r + 1, c] };
        }
      }
    }
  }

  return null;
}

// Helper to swap two cells in-place for calculation
function swapCells(board: CellTile[][], r1: number, c1: number, r2: number, c2: number) {
  const temp = board[r1][c1];
  board[r1][c1] = board[r2][c2];
  board[r2][c2] = temp;
}

// Shuffle board candies when no moves are available
export function shuffleBoard(board: CellTile[][], allowedColors: CandyColor[], seed = 0x51f15e): CellTile[][] {
  const rows = board.length;
  const cols = board[0].length;
  const pool: { color: CandyColor; special: SpecialType }[] = [];
  const random = createSeededRandom(seed);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (cell && !cell.hasChocolate && !cell.isIngredient) {
        pool.push({ color: cell.color, special: cell.special });
      }
    }
  }

  // Shuffle pool
  for (let i = pool.length - 1; i > 0; i--) {
    const j = random.integer(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const newBoard = board.map(row => row.map(cell => ({ ...cell })));
  let poolIdx = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = newBoard[r][c];
      if (cell && !cell.hasChocolate && !cell.isIngredient && poolIdx < pool.length) {
        const item = pool[poolIdx++];
        newBoard[r][c] = {
          ...cell,
          id: `tile_shuffle_${seed}_${poolIdx}`,
          color: item.color,
          special: item.special,
        };
      }
    }
  }

  return newBoard;
}
