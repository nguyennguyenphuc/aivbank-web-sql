import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ActiveEffect,
  BoosterType,
  CandyColor,
  CellTile,
  LevelConfig,
  Objective,
  PlayerInventory,
  SpecialType,
} from '../types/game';
import {
  areNeighbors,
  createInitialBoard,
  findMatches,
  findPossibleMove,
  generateTileId,
  getSpecialExplosions,
  resolveSpecialSwap,
  shuffleBoard,
} from '../utils/gameEngine';
import { soundFx } from '../utils/audio';
import { TileView } from './TileView';
import { BoosterBar } from './BoosterBar';
import { useGameObservation } from '../features/analytics/game-observation-context';

interface GameScreenProps {
  level: LevelConfig;
  inventory: PlayerInventory;
  onWinLevel: (score: number, stars: number) => void;
  onLoseLevel: (objectives: Objective[]) => void;
  onBackToMap: () => void;
  onConsumeBooster: (type: BoosterType, referenceId: string) => Promise<void>;
  onOpenShop: () => void;
  language: 'vi' | 'en';
  initialExtraMoves?: number;
}

export const GameScreen: React.FC<GameScreenProps> = ({
  level,
  inventory,
  onWinLevel,
  onLoseLevel,
  onBackToMap,
  onConsumeBooster,
  onOpenShop,
  language,
  initialExtraMoves = 0,
}) => {
  const isVi = language === 'vi';
  const record = useGameObservation();
  const swapPending = useRef(false);
  useEffect(() => {
    record({ type: 'level_started', movesLeft: level.moves + initialExtraMoves });
  }, [level.moves, initialExtraMoves, record]);

  // Game States
  const [board, setBoard] = useState<CellTile[][]>(() => createInitialBoard(level));
  const [score, setScore] = useState<number>(0);
  const [movesLeft, setMovesLeft] = useState<number>(level.moves + initialExtraMoves);
  const [timeLeft, setTimeLeft] = useState<number | undefined>(level.timeLimit);
  const [objectives, setObjectives] = useState<Objective[]>(() =>
    level.objectives.map(obj => ({ ...obj, current: 0 }))
  );
  const [bossHp, setBossHp] = useState<number | undefined>(level.boss?.currentHp);
  const [selectedTile, setSelectedTile] = useState<{ row: number; col: number } | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [activeBooster, setActiveBooster] = useState<BoosterType | null>(null);
  const [effects, setEffects] = useState<ActiveEffect[]>([]);
  const [comboBanner, setComboBanner] = useState<string | null>(null);
  const [hintMove, setHintMove] = useState<{ from: [number, number]; to: [number, number] } | null>(null);
  const [boosterMessage, setBoosterMessage] = useState<string | null>(null);
  const [touchDrag, setTouchDrag] = useState<{ row: number; col: number; x: number; y: number } | null>(null);
  const [snapConfirm, setSnapConfirm] = useState<Set<string>>(new Set());

  // Drag / Touch coordinates tracker
  const touchStartRef = useRef<{ row: number; col: number; x: number; y: number } | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const boosterActionRef = useRef(0);
  const practiceSessionRef = useRef(crypto.randomUUID());
  const immediateBoosterPendingRef = useRef(false);
  const directBoosterPendingRef = useRef(false);
  const boosterRetryKeysRef = useRef(new Map<string, string>());
  const boosterMessageTimerRef = useRef<number | null>(null);
  const levelEndTimerRef = useRef<number | null>(null);
  const isLevelEndedRef = useRef<boolean>(false);
  const isActiveRef = useRef(true);

  // Reset idle timer for hints
  const resetIdleTimer = useCallback(() => {
    setHintMove(null);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);

    idleTimerRef.current = window.setTimeout(() => {
      if (!isProcessing && !isLevelEndedRef.current) {
        const possible = findPossibleMove(board, level.allowedColors);
        if (possible) {
          setHintMove(possible);
        }
      }
    }, 4000);
  }, [board, isProcessing, level.allowedColors]);

  useEffect(() => {
    resetIdleTimer();
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [resetIdleTimer]);

  useEffect(() => {
    isActiveRef.current = true;
    return () => {
      isActiveRef.current = false;
      if (boosterMessageTimerRef.current) clearTimeout(boosterMessageTimerRef.current);
      if (levelEndTimerRef.current) clearTimeout(levelEndTimerRef.current);
    };
  }, []);

  // Timed challenge countdown
  useEffect(() => {
    if (timeLeft === undefined || timeLeft <= 0 || isLevelEndedRef.current) return;

    const timer = setInterval(() => {
      setTimeLeft(prev => prev === undefined ? prev : Math.max(0, prev - 1));
    }, 1000);

    return () => clearInterval(timer);
  }, [timeLeft]);

  // Finish only after an in-flight move resolves, using the latest board and score.
  useEffect(() => {
    if (timeLeft === 0 && !isProcessing && !isLevelEndedRef.current) {
      checkEndConditions(board, objectives, 0, score);
    }
  }, [timeLeft, isProcessing, board, objectives, score]);

  // Helper to add visual effect
  const triggerEffect = (effect: ActiveEffect) => {
    setEffects(prev => [...prev, effect]);
    setTimeout(() => {
      setEffects(prev => prev.filter(e => e.id !== effect.id));
    }, 900);
  };

  const confirmSnap = (positions: Array<{ row: number; col: number }>) => {
    setSnapConfirm(new Set(positions.map(pos => `${pos.row},${pos.col}`)));
    window.setTimeout(() => setSnapConfirm(new Set()), 430);
  };

  const flashBoosterMessage = useCallback((message: string) => {
    setBoosterMessage(message);
    if (boosterMessageTimerRef.current) clearTimeout(boosterMessageTimerRef.current);
    boosterMessageTimerRef.current = window.setTimeout(() => setBoosterMessage(null), 2600);
  }, []);

  const consumeBooster = useCallback(async (type: BoosterType, targetId: string): Promise<boolean> => {
    const intentKey = `${type}:${targetId}`;
    const referenceId = boosterRetryKeysRef.current.get(intentKey)
      ?? `practice:${practiceSessionRef.current}:${level.id}:${type}:${targetId}:${boosterActionRef.current++}`;
    boosterRetryKeysRef.current.set(intentKey, referenceId);
    try {
      await onConsumeBooster(type, referenceId);
      if (!isActiveRef.current) return false;
      boosterRetryKeysRef.current.delete(intentKey);
      record({ type: 'booster_used', booster: type });
      return true;
    } catch (cause) {
      if (!isActiveRef.current) return false;
      record({ type: 'booster_failed', booster: type });
      flashBoosterMessage(cause instanceof Error ? cause.message : 'Không thể dùng vật phẩm');
      return false;
    }
  }, [flashBoosterMessage, level.id, onConsumeBooster, record]);

  // Check victory / defeat conditions
  const checkEndConditions = useCallback(
    (currentBoard: CellTile[][], currentObjectives: Objective[], currentMoves: number, currentScore: number) => {
      if (!isActiveRef.current || isLevelEndedRef.current) return;

      const allGoalsMet = currentObjectives.every(obj => obj.current >= obj.target);

      if (allGoalsMet) {
        isLevelEndedRef.current = true;
        // Calculate stars
        const [s1, s2, s3] = level.starScores;
        // Bonus score for remaining moves (150 pts per move)
        const moveBonus = currentMoves * 150;
        const finalScore = currentScore + moveBonus;
        record({ type: 'level_completed', score: finalScore, baseScore: currentScore, bonus: moveBonus, won: true });

        let stars = 1;
        if (finalScore >= s3) stars = 3;
        else if (finalScore >= s2) stars = 2;

        setComboBanner(isVi ? 'Hoàn thành!' : 'Level clear!');
        if (levelEndTimerRef.current) clearTimeout(levelEndTimerRef.current);
        levelEndTimerRef.current = window.setTimeout(() => {
          onWinLevel(finalScore, stars);
        }, 1200);
        return;
      }

      // Check out of moves / time
      if (currentMoves <= 0 || (timeLeft !== undefined && timeLeft <= 0)) {
        isLevelEndedRef.current = true;
        record({ type: 'level_completed', score: currentScore, baseScore: currentScore, bonus: 0, won: false });
        if (levelEndTimerRef.current) clearTimeout(levelEndTimerRef.current);
        levelEndTimerRef.current = window.setTimeout(() => {
          onLoseLevel(currentObjectives);
        }, 1000);
      }
    },
    [isVi, level.starScores, onLoseLevel, onWinLevel, timeLeft, record]
  );

  // Apply clears, gravity, refill, and cascading loop.
  const processBoardCascades = async (
    startBoard: CellTile[][],
    initialMultiplier = 1,
    initialClears: { row: number; col: number }[] = []
  ) => {
    setIsProcessing(true);
    let curBoard = startBoard.map(r => r.map(c => ({ ...c })));
    let combo = initialMultiplier;
    let turnScore = 0;
    let cascadeCount = 0;
    let updatedObjectives = [...objectives];
    let updatedBossHp = bossHp;

    const settleBoard = async () => {
      const rows = curBoard.length;
      const cols = curBoard[0].length;

      for (let c = 0; c < cols; c++) {
        let emptyRow = rows - 1;
        for (let r = rows - 1; r >= 0; r--) {
          if (curBoard[r][c] !== null) {
            if (r !== emptyRow) {
              curBoard[emptyRow][c] = {
                ...curBoard[r][c],
                row: emptyRow,
                col: c,
              };
              curBoard[r][c] = null as unknown as CellTile;
            }
            emptyRow--;
          }
        }

        for (let r = emptyRow; r >= 0; r--) {
          const randColor = level.allowedColors[Math.floor(Math.random() * level.allowedColors.length)];
          curBoard[r][c] = {
            id: generateTileId(),
            row: r,
            col: c,
            color: randColor,
            special: 'none',
            iceLevel: 0,
            hasChocolate: false,
            isIngredient: false,
          };
        }
      }

      for (let c = 0; c < cols; c++) {
        const bottomCell = curBoard[rows - 1][c];
        if (bottomCell && bottomCell.isIngredient) {
          soundFx.playSpecialCreated();
          updatedObjectives = updatedObjectives.map(obj => {
            if (obj.type === 'DROP_INGREDIENT') {
              return { ...obj, current: Math.min(obj.target, obj.current + 1) };
            }
            return obj;
          });
          curBoard[rows - 1][c] = {
            ...bottomCell,
            isIngredient: false,
            color: level.allowedColors[Math.floor(Math.random() * level.allowedColors.length)],
          };
        }
      }

      setBoard(curBoard.map(r => r.map(c => ({ ...c }))));
      setObjectives(updatedObjectives);
      await new Promise(res => setTimeout(res, 260));
    };

    const resolveClearBatch = (
      clearPositions: { row: number; col: number }[],
      batchCombo: number,
      triggeredSpecials: { row: number; col: number; special: SpecialType; color: CandyColor }[] = [],
      createdSpecials: { row: number; col: number; special: SpecialType; color: CandyColor }[] = [],
      allowSpecialExplosion = true
    ) => {
      const baseSet = new Set<string>();
      clearPositions.forEach(pos => {
        baseSet.add(`${pos.row},${pos.col}`);
      });
      const explodedPositions = allowSpecialExplosion && triggeredSpecials.length > 0
        ? getSpecialExplosions(curBoard, triggeredSpecials)
        : Array.from(baseSet).map(key => {
            const [row, col] = key.split(',').map(Number);
            return { row, col };
          });
      const affectedSet = new Set<string>([
        ...Array.from(baseSet),
        ...explodedPositions.map(pos => `${pos.row},${pos.col}`),
      ]);
      const createdSpecialMap = new Map(createdSpecials.map(sp => [`${sp.row},${sp.col}`, sp]));
      const clearedChocolate = new Set<string>();

      if (updatedBossHp !== undefined && updatedBossHp > 0) {
        const damage = affectedSet.size + (allowSpecialExplosion ? triggeredSpecials.length * 5 : 0);
        updatedBossHp = Math.max(0, updatedBossHp - damage);
        setBossHp(updatedBossHp);
        updatedObjectives = updatedObjectives.map(obj => {
          if (obj.type === 'DEFEAT_BOSS') {
            return { ...obj, current: Math.min(obj.target, obj.target - updatedBossHp) };
          }
          return obj;
        });
      }

      const pts = affectedSet.size * 60 * batchCombo;
      turnScore += pts;
      cascadeCount++;
      setScore(prev => prev + pts);
      updatedObjectives = updatedObjectives.map(obj => {
        if (obj.type === 'SCORE') {
          return { ...obj, current: Math.min(obj.target, obj.current + pts) };
        }
        return obj;
      });

      affectedSet.forEach(key => {
        const [r, c] = key.split(',').map(Number);
        const cell = curBoard[r]?.[c];
        if (!cell) return;

        if (cell.color && !cell.hasChocolate && !cell.isIngredient) {
          updatedObjectives = updatedObjectives.map(obj => {
            if (obj.type === 'COLLECT_COLOR' && obj.color === cell.color) {
              return { ...obj, current: Math.min(obj.target, obj.current + 1) };
            }
            return obj;
          });
        }

        if (cell.iceLevel > 0) {
          soundFx.playIceBreak();
          cell.iceLevel -= 1;
          if (cell.iceLevel === 0) {
            updatedObjectives = updatedObjectives.map(obj => {
              if (obj.type === 'CLEAR_ICE') {
                return { ...obj, current: Math.min(obj.target, obj.current + 1) };
              }
              return obj;
            });
          }
        }

        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nr = r + dr;
            const nc = c + dc;
            if (nr >= 0 && nr < curBoard.length && nc >= 0 && nc < curBoard[0].length) {
              const neighbor = curBoard[nr][nc];
              if (neighbor?.hasChocolate) {
                const chocolateKey = `${nr},${nc}`;
                neighbor.hasChocolate = false;
                if (!clearedChocolate.has(chocolateKey)) {
                  clearedChocolate.add(chocolateKey);
                  soundFx.playIceBreak();
                  updatedObjectives = updatedObjectives.map(obj => {
                    if (obj.type === 'CLEAR_CHOCOLATE') {
                      return { ...obj, current: Math.min(obj.target, obj.current + 1) };
                    }
                    return obj;
                  });
                }
              }
            }
          }
        }
      });

      createdSpecials.forEach(sp => {
        soundFx.playSpecialCreated();
        triggerEffect({
          id: generateTileId(),
          type: sp.special === 'rainbow_candy' ? 'rainbow_pulse' : 'star_burst',
          row: sp.row,
          col: sp.col,
        });
      });

      affectedSet.forEach(key => {
        const [r, c] = key.split(',').map(Number);
        const sp = createdSpecialMap.get(key);
        if (sp) {
          curBoard[r][c] = {
            ...curBoard[r][c],
            color: sp.color,
            special: sp.special,
            isIngredient: false,
          };
        } else {
          curBoard[r][c] = null as unknown as CellTile;
        }
      });
    };

    if (initialClears.length > 0) {
      resolveClearBatch(initialClears, combo, [], [], false);
      await settleBoard();
      combo++;
    }

    while (isActiveRef.current) {
      const matchRes = findMatches(curBoard, level.allowedColors);
      if (matchRes.matches.length === 0) break;

      soundFx.playMatch(combo);

      if (combo >= 2) {
        const praisesVi = ['Ngon Tuyệt!', 'Tuyệt Cú Mèo!', 'Thần Sầu!', 'Siêu Bão Kẹo!', 'Không Thể Tin Nổi!'];
        const praisesEn = ['Sweet!', 'Tasty!', 'Delicious!', 'Sugar Rush!', 'Unbelievable!'];
        const text = isVi
          ? praisesVi[Math.min(combo - 2, praisesVi.length - 1)]
          : praisesEn[Math.min(combo - 2, praisesEn.length - 1)];
        setComboBanner(`${text} (x${combo})`);
        setTimeout(() => setComboBanner(null), 1200);
      }

      const specialsTriggered: { row: number; col: number; special: SpecialType; color: CandyColor }[] = [];
      matchRes.matches.forEach(m => {
        const cell = curBoard[m.row][m.col];
        if (cell && cell.special !== 'none') {
          specialsTriggered.push({ row: m.row, col: m.col, special: cell.special, color: cell.color });
        }
      });

      resolveClearBatch(matchRes.matches, combo, specialsTriggered, matchRes.createdSpecials, true);
      await settleBoard();
      combo++;
    }

    if (!isActiveRef.current) return { board: curBoard, objectives: updatedObjectives, turnScore, cascadeCount };
    const hasMove = findPossibleMove(curBoard, level.allowedColors);
    if (!hasMove) {
      setComboBanner(isVi ? 'Đang xáo trộn bàn...' : 'Auto-shuffling board...');
      soundFx.playSwap();
      curBoard = shuffleBoard(curBoard, level.allowedColors);
      record({ type: 'board_shuffled' });
      setBoard(curBoard);
      setTimeout(() => setComboBanner(null), 1500);
    }

    setIsProcessing(false);
    resetIdleTimer();
    return { board: curBoard, objectives: updatedObjectives, turnScore, cascadeCount };
  };

  // Perform a Swap between 2 tiles
  const executeSwap = async (r1: number, c1: number, r2: number, c2: number) => {
    if (isProcessing || swapPending.current || movesLeft <= 0 || isLevelEndedRef.current) return;
    if (![r1, c1, r2, c2].every(Number.isInteger) || !board[r1]?.[c1] || !board[r2]?.[c2]) return;
    if (!areNeighbors(r1, c1, r2, c2)) {
      record({ type: 'move_rejected', reason: 'not_adjacent' });
      setSelectedTile(null);
      return;
    }

    const tileA = board[r1][c1];
    const tileB = board[r2][c2];
    if (!tileA || !tileB || tileA.hasChocolate || tileB.hasChocolate) {
      record({ type: 'move_rejected', reason: 'blocked' });
      setSelectedTile(null);
      return;
    }

    swapPending.current = true;
    setTouchDrag(null);
    try {
    setIsProcessing(true);
    soundFx.playSwap();
    confirmSnap([{ row: r1, col: c1 }, { row: r2, col: c2 }]);
    // Check for special candy combos (Rainbow + Bomb, Striped + Striped, etc.)
    const specialComboResult = resolveSpecialSwap(tileA, tileB, board);
    if (specialComboResult) {
      setSelectedTile(null);
      const newMoves = movesLeft - 1;
      setMovesLeft(newMoves);

      // Trigger massive combo blast
      soundFx.playRainbow();
      triggerEffect({
        id: generateTileId(),
        type: 'rainbow_pulse',
        row: r2,
        col: c2,
      });

      const curBoard = board.map(r => r.map(c => ({ ...c })));
      const result = await processBoardCascades(curBoard, 2, specialComboResult);
      if (!isActiveRef.current) return;
      record({ type: 'move_resolved', score: score + result.turnScore, delta: result.turnScore, cascades: result.cascadeCount, movesLeft: newMoves });
      checkEndConditions(result.board, result.objectives, newMoves, score + result.turnScore);
      return;
    }

    // Normal swap check
    const tempBoard = board.map(r => r.map(c => ({ ...c })));
    tempBoard[r1][c1] = { ...tileB, row: r1, col: c1 };
    tempBoard[r2][c2] = { ...tileA, row: r2, col: c2 };

    const matchRes = findMatches(tempBoard, level.allowedColors);

    if (matchRes.matches.length > 0) {
      // Valid move!
      setSelectedTile(null);
      const newMoves = movesLeft - 1;
      setMovesLeft(newMoves);
      setBoard(tempBoard);
      confirmSnap([{ row: r1, col: c1 }, { row: r2, col: c2 }]);

      const result = await processBoardCascades(tempBoard, 1);
      if (!isActiveRef.current) return;
      record({ type: 'move_resolved', score: score + result.turnScore, delta: result.turnScore, cascades: result.cascadeCount, movesLeft: newMoves });
      checkEndConditions(result.board, result.objectives, newMoves, score + result.turnScore);
    } else {
      // Invalid move -> Bounce back
      record({ type: 'move_rejected', reason: 'no_match' });
      soundFx.playClick();
      setSelectedTile(null);
      setIsProcessing(false);
      confirmSnap([{ row: r1, col: c1 }, { row: r2, col: c2 }]);
    }
    } finally {
      swapPending.current = false;
    }
  };

  // Booster Execution
  const handleUseBoosterOnCell = async (r: number, c: number) => {
    if (!activeBooster || isProcessing || directBoosterPendingRef.current || isLevelEndedRef.current || !isActiveRef.current) return;

    const cell = board[r][c];
    if (!cell) return;

    directBoosterPendingRef.current = true;
    setIsProcessing(true);
    const boosterType = activeBooster;
    try {
      const consumed = await consumeBooster(boosterType, `${r}:${c}`);
      if (!consumed) return;
      setActiveBooster(null);

      const curBoard = board.map(row => row.map(cell => ({ ...cell })));
      const clearedPositions: { row: number; col: number }[] = [];

      if (boosterType === 'hammer') {
        soundFx.playBomb();
        triggerEffect({ id: generateTileId(), type: 'bomb_blast', row: r, col: c });
        clearedPositions.push({ row: r, col: c });
      } else if (boosterType === 'lightning') {
        soundFx.playRocket();
        triggerEffect({ id: generateTileId(), type: 'rocket_h', row: r, col: c });
        for (let i = 0; i < curBoard[0].length; i++) clearedPositions.push({ row: r, col: i });
        for (let j = 0; j < curBoard.length; j++) clearedPositions.push({ row: j, col: c });
      }

      const result = await processBoardCascades(curBoard, 1, clearedPositions);
      if (!isActiveRef.current) return;
      record({ type: 'booster_resolved', booster: boosterType, score: score + result.turnScore, delta: result.turnScore, movesLeft });
      checkEndConditions(result.board, result.objectives, movesLeft, score + result.turnScore);
    } finally {
      directBoosterPendingRef.current = false;
      setIsProcessing(false);
    }
  };

  // Handle tile click
  const handleTileClick = (r: number, c: number) => {
    if (isProcessing || isLevelEndedRef.current) return;

    if (activeBooster === 'hammer' || activeBooster === 'lightning') {
      handleUseBoosterOnCell(r, c);
      return;
    }

    soundFx.playClick();
    if (!selectedTile) {
      setSelectedTile({ row: r, col: c });
    } else {
      if (selectedTile.row === r && selectedTile.col === c) {
        setSelectedTile(null);
      } else {
        executeSwap(selectedTile.row, selectedTile.col, r, c);
      }
    }
  };

  // Swipe Gesture Handlers (Mobile & Desktop)
  const handleTouchStart = (r: number, c: number, e: React.TouchEvent) => {
    if (isProcessing || isLevelEndedRef.current || activeBooster || e.touches.length !== 1) {
      touchStartRef.current = null;
      setTouchDrag(null);
      return;
    }
    const touch = e.touches[0];
    touchStartRef.current = { row: r, col: c, x: touch.clientX, y: touch.clientY };
    setTouchDrag({ row: r, col: c, x: 0, y: 0 });
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartRef.current || !e.touches[0]) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) > 4 && e.cancelable) e.preventDefault();
    setTouchDrag({
      row: touchStartRef.current.row,
      col: touchStartRef.current.col,
      x: Math.max(-72, Math.min(72, dx)),
      y: Math.max(-72, Math.min(72, dy)),
    });
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current || !e.changedTouches[0]) {
      setTouchDrag(null);
      return;
    }
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    const { row: r, col: c } = touchStartRef.current;
    setTouchDrag(null);
    touchStartRef.current = null;

    const threshold = 18;
    if (Math.max(Math.abs(dx), Math.abs(dy)) <= threshold) return;
    // A swipe must not also synthesize a tap on its starting candy.
    if (e.cancelable) e.preventDefault();
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > threshold) {
      const targetCol = dx > 0 ? c + 1 : c - 1;
      if (targetCol >= 0 && targetCol < level.cols) {
        executeSwap(r, c, r, targetCol);
      }
    } else if (Math.abs(dy) > threshold) {
      const targetRow = dy > 0 ? r + 1 : r - 1;
      if (targetRow >= 0 && targetRow < level.rows) {
        executeSwap(r, c, targetRow, c);
      }
    }
  };

  // Score Progress towards 3 stars
  const [, , s3] = level.starScores;

  return (
    <div className="practice-game-shell w-full min-h-[calc(100svh-112px)] bg-transparent flex flex-col items-center justify-center select-none relative overflow-hidden text-[#4A3B2C]">
      {/* TOP STATUS BAR */}
      <header className="w-full max-w-xl px-3 py-2 bg-white/88 border border-white shadow-sm flex items-center justify-between gap-2 rounded-[1.35rem]">
        {/* Back button & Level info */}
        <div className="flex items-center gap-2.5">
          <button
            id="btn-game-back"
            aria-label={isVi ? 'Về bản đồ' : 'Back to map'}
            onClick={() => {
              soundFx.playClick();
              onBackToMap();
            }}
            className="w-10 h-10 rounded-2xl bg-white text-[#855D00] font-black text-sm flex items-center justify-center border-2 border-[#FF9F1A] shadow-[0_3px_0_#FF9F1A] hover:translate-y-0.5 active:translate-y-1 transition-all"
          >
            ◀
          </button>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="bg-[#FFF1CC] text-[#855D00] text-[11px] font-black px-2.5 py-0.5 rounded-full border border-[#FF9F1A] shadow-inner">
                Màn {level.id}
              </span>
              <span className="font-extrabold text-xs sm:text-sm text-[#855D00] truncate max-w-[120px] sm:max-w-none">
                {isVi ? level.nameVi : level.nameEn}
              </span>
            </div>
            <div className="flex items-center gap-1 mt-0.5">
              <span className="text-[11px] font-black text-[#855D00]">
                {score.toLocaleString()}
              </span>
            </div>
          </div>
        </div>

        {/* Moves / Timer Bubble */}
        <div className="flex items-center gap-2">
          {timeLeft !== undefined ? (
            <div className="px-3.5 py-1 bg-white text-[#2D5A85] rounded-2xl border-4 border-[#5EADFF] shadow-[0_4px_0_#4D8ECC] flex flex-col items-center">
              <span className="text-[9px] font-black uppercase tracking-wider">{isVi ? 'Thời Gian' : 'Time'}</span>
              <span className="text-base sm:text-lg font-black font-heading leading-none">
                ⏱️ {timeLeft}s
              </span>
            </div>
          ) : (
            <div data-testid="practice-moves-remaining" className="px-4 py-1 bg-white text-[#2D5A85] rounded-2xl border-4 border-[#5EADFF] shadow-[0_4px_0_#4D8ECC] flex flex-col items-center">
              <span className="text-[9px] font-black uppercase tracking-wider">{isVi ? 'Lượt Đi' : 'Moves'}</span>
              <span className="text-base sm:text-lg font-black font-heading leading-none">
                {movesLeft}
              </span>
            </div>
          )}
        </div>
      </header>

      {/* OBJECTIVES HUD & BOSS BAR */}
      <div className="w-full max-w-xl px-3 my-2 flex flex-col gap-2">
        {level.boss && bossHp !== undefined && (
          <div className="w-full p-2.5 bg-white rounded-[2rem] border-4 border-[#FF9F1A] shadow-[0_6px_0_#E6B800] flex items-center gap-3">
            <span className="text-3xl animate-bounce">{level.boss.avatar}</span>
            <div className="flex-1">
              <div className="flex justify-between text-xs font-black mb-1 text-[#855D00]">
                <span>{isVi ? level.boss.nameVi : level.boss.nameEn}</span>
                <span>
                  {bossHp} / {level.boss.maxHp} HP
                </span>
              </div>
              <div className="w-full bg-[#FFF1CC] rounded-full h-3.5 p-0.5 border border-[#FF9F1A] overflow-hidden">
                <div
                  className="bg-gradient-to-r from-[#FF7A00] to-[#FFCF4D] h-full rounded-full transition-all duration-300"
                  style={{ width: `${Math.max(0, (bossHp / level.boss.maxHp) * 100)}%` }}
                ></div>
              </div>
            </div>
          </div>
        )}

        <div className="w-full bg-white/92 p-2.5 rounded-[1.6rem] border-2 border-[#88D66C] shadow-[0_4px_0_#71B15A] flex flex-col items-center">
          <div className="flex items-center justify-center gap-2 flex-wrap">
            {objectives.map((obj, i) => {
              const isDone = obj.current >= obj.target;
              return (
                <div
                  key={i}
                  className={`px-3 py-1 rounded-xl border-2 shadow-sm flex items-center gap-1.5 text-xs font-black transition-all ${
                    isDone
                      ? 'bg-[#E8F8E5] border-[#88D66C] text-[#4A7A37]'
                      : 'bg-[#F0FFF0] border-[#88D66C] text-[#4A7A37]'
                  }`}
                >
                  <span aria-hidden="true">{isDone ? '✓' : obj.color ? '●' : obj.type === 'CLEAR_ICE' ? '◆' : obj.type === 'CLEAR_CHOCOLATE' ? '■' : obj.type === 'DROP_INGREDIENT' ? '⬇' : '★'}</span>
                  <span>
                    {obj.current} / {obj.type === 'SCORE' ? obj.target.toLocaleString() : obj.target}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* MATCH-3 BOARD GRID CONTAINER */}
      <main className="relative flex items-center justify-center my-auto p-1">
        {/* Floating Combo Banner */}
        <AnimatePresence>
          {comboBanner && (
            <motion.div
              initial={{ scale: 0.4, opacity: 0, y: -20 }}
              animate={{ scale: 1.15, opacity: 1, y: 0 }}
              exit={{ scale: 0.8, opacity: 0 }}
              className="absolute z-40 px-6 py-2 bg-gradient-to-r from-[#FF7A00] via-[#FFCF4D] to-[#88D66C] text-white font-black text-base sm:text-xl rounded-full shadow-2xl border-4 border-white pointer-events-none filter drop-shadow-lg"
            >
              {comboBanner}
            </motion.div>
          )}
        </AnimatePresence>

        {/* The Grid Outer Frame & Inner Board */}
        <div
          data-testid="practice-board"
          onTouchCancel={() => { touchStartRef.current = null; setTouchDrag(null); }}
          className="bg-[#FFD966] p-3 sm:p-4 rounded-[2.5rem] shadow-xl border-8 border-white flex items-center justify-center relative overflow-hidden"
        >
          <div
            className="bg-[#F7E1B5] rounded-[1.5rem] shadow-inner p-1.5 sm:p-2.5 grid gap-1 relative overflow-hidden"
            style={{
              gridTemplateRows: `repeat(${level.rows}, minmax(0, 1fr))`,
              gridTemplateColumns: `repeat(${level.cols}, minmax(0, 1fr))`,
              width: `min(88vw, min(68svh, ${level.cols * 64}px))`,
              height: `min(88vw, min(68svh, ${level.rows * 64}px))`,
            }}
          >
            {board.map((row, r) =>
              row.map((tile, c) => {
                if (!tile) return <div key={`empty-${r}-${c}`} className="w-full h-full" />;

                const isSelected = selectedTile?.row === r && selectedTile?.col === c;
                const isHint =
                  hintMove &&
                  ((hintMove.from[0] === r && hintMove.from[1] === c) ||
                    (hintMove.to[0] === r && hintMove.to[1] === c));

                return (
                  <TileView
                    key={tile.id}
                    tile={tile}
                    isSelected={isSelected}
                    isHinted={Boolean(isHint)}
                    dragOffset={touchDrag?.row === r && touchDrag.col === c ? { x: touchDrag.x, y: touchDrag.y } : null}
                    isConfirming={snapConfirm.has(`${r},${c}`)}
                    onClick={() => handleTileClick(r, c)}
                    onTouchStart={e => handleTouchStart(r, c, e)}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={e => handleTouchEnd(e)}
                    onDragStart={e => {
                      e.dataTransfer.setData('text/plain', `${r},${c}`);
                    }}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => {
                      e.preventDefault();
                      const from = e.dataTransfer.getData('text/plain');
                      if (from) {
                        const [fr, fc] = from.split(',').map(Number);
                        executeSwap(fr, fc, r, c);
                      }
                    }}
                  />
                );
              })
            )}

            {/* Active Effects Layer (Rockets, Lasers, Bombs) */}
            {effects.map(eff => (
              <div
                key={eff.id}
                className={`absolute pointer-events-none z-30 ${
                  eff.type === 'rainbow_pulse' ? 'inset-0 bg-white/40 animate-pulse' : 'animate-shockwave'
                }`}
              />
            ))}
          </div>
        </div>
      </main>

      {/* BOTTOM BOOSTER BAR */}
      <footer className="w-full px-3 mt-2 flex flex-col items-center">
        {boosterMessage && (
          <div role="status" className="mb-2 rounded-2xl border-2 border-rose-200 bg-rose-50 px-4 py-2 text-center text-sm font-black text-rose-700 shadow-sm">
            {boosterMessage}
          </div>
        )}
        <BoosterBar
          inventory={inventory}
          activeBooster={activeBooster}
          onSelectBooster={type => {
            if (isProcessing || isLevelEndedRef.current || !isActiveRef.current) return;
            if (!type) {
              setActiveBooster(null);
              boosterRetryKeysRef.current.clear();
              return;
            }
            if (type === 'shuffle') {
              void (async () => {
                if (immediateBoosterPendingRef.current) return;
                immediateBoosterPendingRef.current = true;
                setIsProcessing(true);
                try {
                  if (!(await consumeBooster('shuffle', 'board'))) return;
                  soundFx.playSwap();
                  setActiveBooster(null);
                  setBoard(shuffleBoard(board, level.allowedColors));
                  record({ type: 'booster_resolved', booster: 'shuffle', score, delta: 0, movesLeft });
                } finally {
                  immediateBoosterPendingRef.current = false;
                  setIsProcessing(false);
                }
              })();
              return;
            }
            if (type === 'extraMoves') {
              void (async () => {
                if (immediateBoosterPendingRef.current) return;
                immediateBoosterPendingRef.current = true;
                setIsProcessing(true);
                try {
                  if (!(await consumeBooster('extraMoves', 'moves'))) return;
                  soundFx.playSpecialCreated();
                  setActiveBooster(null);
                  setMovesLeft(prev => prev + 5);
                  record({ type: 'booster_resolved', booster: 'extraMoves', score, delta: 0, movesLeft: movesLeft + 5 });
                } finally {
                  immediateBoosterPendingRef.current = false;
                  setIsProcessing(false);
                }
              })();
              return;
            }
            setActiveBooster(type);
          }}
          onOpenShop={onOpenShop}
          language={language}
          disabled={isProcessing || isLevelEndedRef.current}
        />
      </footer>
    </div>
  );
};
