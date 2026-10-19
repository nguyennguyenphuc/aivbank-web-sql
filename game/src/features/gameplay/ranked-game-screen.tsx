import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { applyMove, createBoard, type BoardCell, type BoardConfig, type BoardState, type Coordinate, type EngineObjective, type MoveRecord } from '../../../shared/engine';
import { CandyArt } from '../../components/TileView';
import type { LevelConfig } from '../../types/game';
import { soundFx } from '../../utils/audio';
import { apiFetch } from '../auth/api-client';
import { useGameObservation } from '../analytics/game-observation-context';

interface StartRunResponse {
  runId: string;
  runToken: string;
  engine: { board: BoardConfig; objectives: EngineObjective[]; moveBudget: number };
}

interface SubmitResponse { accepted: boolean; suspicious: boolean; authoritativeScore: number; authoritativeWon: boolean; reason?: string }

type Impact = 'idle' | 'soft' | 'strong' | 'invalid';

interface ScorePop { id: number; delta: number }
interface PointerGesture { pointerId: number; row: number; col: number; x: number; y: number }

const SPARKS = [
  { left: '10%', top: '24%', x: -30, y: -34, delay: 0 },
  { left: '26%', top: '8%', x: -12, y: -42, delay: .04 },
  { left: '52%', top: '4%', x: 8, y: -46, delay: .08 },
  { left: '75%', top: '10%', x: 20, y: -38, delay: .12 },
  { left: '91%', top: '28%', x: 34, y: -22, delay: .16 },
  { left: '84%', top: '76%', x: 28, y: 30, delay: .08 },
  { left: '18%', top: '82%', x: -28, y: 24, delay: .12 },
] as const;

export function RankedGameScreen({ level, language, onWin, onLose, onBack, onOfflineFallback }: {
  level: LevelConfig;
  language: 'vi' | 'en';
  onWin: (score: number, stars: number) => void;
  onLose: () => void;
  onBack: () => void;
  onOfflineFallback: () => void;
}) {
  const [run, setRun] = useState<StartRunResponse>();
  const [board, setBoard] = useState<BoardState>();
  const [objectives, setObjectives] = useState<EngineObjective[]>([]);
  const [moves, setMoves] = useState<MoveRecord[]>([]);
  const [score, setScore] = useState(0);
  const [selected, setSelected] = useState<Coordinate>();
  const [combo, setCombo] = useState<string>();
  const [scorePop, setScorePop] = useState<ScorePop>();
  const [impact, setImpact] = useState<Impact>('idle');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const ended = useRef(false);
  const lifecycle = useRef(0);
  const interactionLocked = useRef(false);
  const gesture = useRef<PointerGesture>();
  const suppressClick = useRef(false);
  const feedbackId = useRef(0);
  const feedbackTimer = useRef<number>();
  const unlockTimer = useRef<number>();
  const finishTimer = useRef<number>();
  const suppressTimer = useRef<number>();
  const isVi = language === 'vi';
  const reduceMotion = useReducedMotion();
  const record = useGameObservation();

  useEffect(() => {
    const lifecycleId = ++lifecycle.current;
    let active = true;
    ended.current = false;
    interactionLocked.current = false;
    gesture.current = undefined;
    setRun(undefined);
    setBoard(undefined);
    setObjectives([]);
    setMoves([]);
    setScore(0);
    setSelected(undefined);
    setCombo(undefined);
    setScorePop(undefined);
    setImpact('idle');
    setError(undefined);
    setSubmitting(false);
    apiFetch<StartRunResponse>('/api/gameplay/runs/start', {
      method: 'POST', body: JSON.stringify({ levelId: level.id, contentRevision: 'content.v2.1.1', appVersion: '2.1.1' }),
    }).then(started => {
      if (!active) return;
      setRun(started);
      setBoard(createBoard(started.engine.board));
      setObjectives(started.engine.objectives.map(item => ({ ...item })));
      record({ type: 'level_started', movesLeft: started.engine.moveBudget });
    }).catch(cause => {
      if (!active) return;
      record({ type: 'start_failed' });
      setError(cause instanceof Error ? cause.message : 'Không thể bắt đầu màn ranked');
    });
    return () => {
      active = false;
      if (lifecycle.current === lifecycleId) lifecycle.current++;
      window.clearTimeout(feedbackTimer.current);
      window.clearTimeout(unlockTimer.current);
      window.clearTimeout(finishTimer.current);
      window.clearTimeout(suppressTimer.current);
    };
  }, [level.id, record]);

  const finish = async (nextMoves: MoveRecord[], nextScore: number, won: boolean) => {
    if (!run || ended.current) return;
    const lifecycleId = lifecycle.current;
    ended.current = true;
    interactionLocked.current = true;
    setSubmitting(true);
    record({ type: 'verification_started' });
    try {
      const result = await apiFetch<SubmitResponse>('/api/gameplay/runs/submit', {
        method: 'POST', body: JSON.stringify({ runId: run.runId, runToken: run.runToken, moves: nextMoves, claimedScore: nextScore, claimedWon: won }),
      });
      if (lifecycle.current !== lifecycleId) return;
      if (!result.accepted) {
        record({ type: 'verification_failed', reason: 'rejected' });
        setError(isVi ? 'Máy chủ không chấp nhận lượt này. Về bản đồ để chơi lại.' : 'The server rejected this attempt. Return to the map to retry.');
        return;
      }
      record({ type: 'verification_completed', score: result.authoritativeScore, won: result.authoritativeWon });
      if (result.authoritativeWon) {
        const [one, two, three] = level.starScores;
        const stars = result.authoritativeScore >= three ? 3 : result.authoritativeScore >= two ? 2 : result.authoritativeScore >= one ? 1 : 1;
        onWin(result.authoritativeScore, stars);
      } else onLose();
    } catch (cause) {
      if (lifecycle.current !== lifecycleId) return;
      record({ type: 'verification_failed', reason: 'unavailable' });
      const detail = cause instanceof Error ? cause.message : (isVi ? 'Không thể xác thực kết quả' : 'Could not verify the result');
      setError(isVi
        ? `Kết quả chưa thể xác nhận (${detail}). Hãy về bản đồ để bắt đầu lượt chơi mới.`
        : `The result could not be confirmed (${detail}). Return to the map and start a new run.`);
    } finally {
      if (lifecycle.current === lifecycleId) setSubmitting(false);
    }
  };

  const showFeedback = (message: string, delta: number, nextImpact: Impact) => {
    const id = ++feedbackId.current;
    setCombo(message);
    setScorePop({ id, delta });
    setImpact(nextImpact);
    window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => {
      setCombo(undefined);
      setScorePop(undefined);
    }, 980);
  };

  const executeMove = (from: Coordinate, to: Coordinate) => {
    if (!board || !run || submitting || ended.current || interactionLocked.current) return;
    interactionLocked.current = true;
    const hasSpecial = [from, to].some(position => {
      const special = board.cells[position.row]?.[position.col]?.candy?.special;
      return Boolean(special && special !== 'none');
    });
    const result = applyMove(board, { from, to }, objectives, run.engine.board.colors, moves.length);
    setSelected(undefined);
    if (!result.accepted || !result.record) {
      record({ type: 'move_rejected', reason: result.reason === 'not-adjacent' ? 'not_adjacent' : result.reason === 'blocked' ? 'blocked' : 'no_match' });
      soundFx.playSwap();
      safeVibrate(18);
      setCombo(isVi ? 'Chưa ghép được — thử hướng khác!' : 'No match — try another direction!');
      setImpact('invalid');
      window.clearTimeout(feedbackTimer.current);
      feedbackTimer.current = window.setTimeout(() => setCombo(undefined), 760);
      window.clearTimeout(unlockTimer.current);
      unlockTimer.current = window.setTimeout(() => { interactionLocked.current = false; }, 190);
      return;
    }

    const nextMoves = [...moves, result.record];
    const nextScore = score + result.scoreDelta;
    const message = result.shuffled
      ? (isVi ? 'Đổi vị trí — đường ngọt mới!' : 'Fresh shuffle — new sweet paths!')
      : hasSpecial
        ? (isVi ? 'Siêu kẹo bùng nổ!' : 'Special candy blast!')
        : result.cascades > 1
          ? `${isVi ? 'Combo ngọt lịm' : 'Sweet cascade'} ×${result.cascades}`
          : (isVi ? 'Ghép ngon!' : 'Sweet match!');

    setBoard(result.board);
    setObjectives(result.objectives);
    setMoves(nextMoves);
    setScore(nextScore);
    record({ type: 'move_resolved', score: nextScore, delta: result.scoreDelta, cascades: result.cascades, movesLeft: run.engine.moveBudget - nextMoves.length });
    if (result.shuffled) record({ type: 'board_shuffled' });
    showFeedback(message, result.scoreDelta, hasSpecial || result.cascades > 1 ? 'strong' : 'soft');
    if (hasSpecial) soundFx.playSpecialCreated();
    else soundFx.playMatch(Math.max(1, result.cascades));
    safeVibrate(hasSpecial || result.cascades > 2 ? [18, 24, 34] : 14);

    const won = result.objectives.every(objective => objective.current >= objective.target);
    const finished = won || nextMoves.length >= run.engine.moveBudget;
    if (finished) {
      record({ type: 'level_completed', score: nextScore, baseScore: nextScore, bonus: 0, won });
      window.clearTimeout(finishTimer.current);
      finishTimer.current = window.setTimeout(() => void finish(nextMoves, nextScore, won), 720);
    } else {
      window.clearTimeout(unlockTimer.current);
      unlockTimer.current = window.setTimeout(() => { interactionLocked.current = false; }, 260);
    }
  };

  const choose = (position: Coordinate) => {
    if (!board || !run || submitting || ended.current || interactionLocked.current) return;
    if (!selected) {
      soundFx.playClick();
      setSelected(position);
      return;
    }
    if (selected.row === position.row && selected.col === position.col) {
      soundFx.playClick();
      setSelected(undefined);
      return;
    }
    executeMove(selected, position);
  };

  const beginGesture = (position: Coordinate, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (submitting || ended.current || interactionLocked.current) return;
    gesture.current = { pointerId: event.pointerId, row: position.row, col: position.col, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const endGesture = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = gesture.current;
    if (!start || start.pointerId !== event.pointerId) return;
    gesture.current = undefined;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const threshold = 18;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return;
    const to = Math.abs(dx) > Math.abs(dy)
      ? { row: start.row, col: start.col + (dx > 0 ? 1 : -1) }
      : { row: start.row + (dy > 0 ? 1 : -1), col: start.col };
    if (!board || to.row < 0 || to.row >= board.rows || to.col < 0 || to.col >= board.cols) return;
    suppressClick.current = true;
    window.clearTimeout(suppressTimer.current);
    suppressTimer.current = window.setTimeout(() => { suppressClick.current = false; }, 80);
    executeMove({ row: start.row, col: start.col }, to);
  };

  const handleCellClick = (position: Coordinate) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    choose(position);
  };

  if (error && !board) return (
    <main className="min-h-screen bg-[#FFF9E6] p-5 flex items-center justify-center">
      <section className="max-w-md rounded-3xl bg-white p-6 text-center shadow-xl">
        <div className="text-5xl">📡</div><h1 className="mt-3 text-xl font-black">{isVi ? 'Không kết nối được máy chủ' : 'Server unavailable'}</h1>
        <p className="mt-2 text-sm font-bold text-slate-600">{error}</p>
        <button onClick={onOfflineFallback} className="mt-5 rounded-2xl bg-[#3F6F30] px-5 py-3 font-black text-white">{isVi ? 'Luyện tập offline' : 'Offline practice'}</button>
        <button onClick={onBack} className="mt-3 block w-full text-sm font-black text-slate-500">{isVi ? 'Về bản đồ' : 'Back to map'}</button>
      </section>
    </main>
  );

  if (!board || !run) return <main className="min-h-screen bg-[#FFF9E6] flex items-center justify-center" aria-live="polite"><div className="text-center font-black text-[#855D00]"><div className="text-5xl animate-bounce">🍭</div>{isVi ? 'Đang tạo bàn chơi công bằng…' : 'Building a fair board…'}</div></main>;
  const remaining = run.engine.moveBudget - moves.length;
  const starTarget = level.starScores[2] || 1;
  const progress = Math.min(100, (score / starTarget) * 100);
  const stars = score >= level.starScores[2] ? 3 : score >= level.starScores[1] ? 2 : score >= level.starScores[0] ? 1 : 0;

  return (
    <main className="ranked-game-shell min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top,#FFF5C8,#FFE4EF_55%,#DDF2FF)] p-3 pb-8">
      <header className="mx-auto flex max-w-xl items-center justify-between gap-3 rounded-3xl border-4 border-white bg-white/90 p-3 shadow-lg backdrop-blur">
        <button id="btn-ranked-game-back" onClick={onBack} aria-label={isVi ? 'Về bản đồ' : 'Back'} className="h-11 w-11 rounded-2xl bg-[#FFE7B0] font-black text-[#855D00] shadow-[0_3px_0_#FFCF4D] transition active:translate-y-1">←</button>
        <div className="min-w-0 text-center"><p className="text-[10px] font-black uppercase tracking-[.16em] text-[#A66A00]">🔒 {isVi ? 'Thử thách xếp hạng' : 'Ranked challenge'}</p><h1 className="truncate font-heading text-lg font-black text-[#5D4632]">{isVi ? level.nameVi : level.nameEn}</h1></div>
        <div id="ranked-moves-remaining" className="min-w-14 rounded-2xl bg-[#ffdda0] px-3 py-2 text-center font-black text-[#674212] shadow-[0_3px_0_#e6bd7c]"><span className="block text-[9px] uppercase">{isVi ? 'Lượt' : 'Moves'}</span>{remaining}</div>
      </header>

      <section className="mx-auto mt-3 grid max-w-xl grid-cols-2 gap-2" aria-label={isVi ? 'Trạng thái màn chơi' : 'Level status'}>
        <div className="rounded-2xl bg-white p-3 text-center font-black text-[#855D00] shadow">
          <div className="flex items-center justify-center gap-2"><span id="ranked-score">⭐ {score.toLocaleString()}</span><span className="text-xs tracking-tight">{'★'.repeat(stars)}{'☆'.repeat(3 - stars)}</span></div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#FFF1CC]" aria-label={`${Math.round(progress)}%`}>
            <motion.div className="h-full rounded-full bg-gradient-to-r from-[#FFCF4D] via-[#FF9F1A] to-[#F43F5E]" animate={{ width: `${progress}%` }} transition={{ type: 'spring', stiffness: 160, damping: 24 }} />
          </div>
        </div>
        <div className="flex items-center justify-center rounded-2xl bg-white p-3 text-center text-xs font-black text-[#4A7A37] shadow">{objectives.map(item => `${objectiveIcon(item.kind)} ${item.current}/${item.target}`).join(' · ')}</div>
      </section>

      <motion.section
        aria-label={isVi ? 'Bàn kẹo — vuốt một viên sang ô bên cạnh để ghép' : 'Candy board — swipe a candy toward a neighbor to match'}
        className="ranked-candy-board relative mx-auto mt-4 aspect-square w-[min(94vw,560px)] rounded-[2rem] border-8 border-white bg-[#E7C98D] p-2 shadow-2xl"
        animate={reduceMotion ? { x: 0, scale: 1, rotate: 0 } : impact === 'invalid'
          ? { x: [0, -7, 7, -5, 5, 0] }
          : impact === 'strong'
            ? { scale: [1, 1.018, .994, 1], rotate: [0, -.25, .2, 0] }
            : impact === 'soft'
              ? { scale: [1, 1.008, 1] }
              : { x: 0, scale: 1, rotate: 0 }}
        transition={{ duration: impact === 'strong' ? .46 : .28, ease: 'easeOut' }}
        onAnimationComplete={() => setImpact('idle')}
      >
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[1.5rem]" aria-hidden>
          <div className="absolute -left-16 -top-16 h-40 w-40 rounded-full bg-white/35 blur-2xl" />
          <div className="absolute -bottom-20 -right-12 h-48 w-48 rounded-full bg-[#FF9F1A]/20 blur-3xl" />
        </div>

        <AnimatePresence>
          {combo && (
            <motion.div
              key={feedbackId.current}
              initial={reduceMotion ? { opacity: 0 } : { scale: .45, opacity: 0, y: 22, rotate: -4 }}
              animate={reduceMotion ? { opacity: 1 } : { scale: [1.08, 1], opacity: 1, y: 0, rotate: 0 }}
              exit={{ scale: .8, opacity: 0, y: -18 }}
              className="pointer-events-none absolute left-1/2 top-[42%] z-40 w-max max-w-[88%] -translate-x-1/2 rounded-full border-4 border-white bg-gradient-to-r from-[#FF7A00] via-[#F43F5E] to-[#A855F7] px-5 py-2.5 text-center text-[clamp(1rem,4.5vw,1.45rem)] font-black text-white shadow-[0_10px_30px_rgba(244,63,94,.35)]"
              role="status"
              aria-live="polite"
            >
              {combo}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {scorePop && (
            <motion.div key={scorePop.id} initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: .65, y: 8 }} animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1.1, y: -18 }} exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -42 }} className="pointer-events-none absolute right-4 top-3 z-40 rounded-full bg-white px-3 py-1 text-sm font-black text-[#E05700] shadow-lg">
              +{scorePop.delta.toLocaleString()}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {scorePop && impact === 'strong' && !reduceMotion && SPARKS.map((spark, index) => (
            <motion.span
              key={`${scorePop.id}:${index}`}
              className="pointer-events-none absolute z-30 text-lg text-white drop-shadow"
              style={{ left: spark.left, top: spark.top }}
              initial={{ opacity: 0, scale: .2, x: 0, y: 0 }}
              animate={{ opacity: [0, 1, 0], scale: [.2, 1.2, .55], x: spark.x, y: spark.y, rotate: 120 + index * 28 }}
              exit={{ opacity: 0 }}
              transition={{ duration: .7, delay: spark.delay, ease: 'easeOut' }}
              aria-hidden
            >✦</motion.span>
          ))}
        </AnimatePresence>

        <div className="relative z-10 grid h-full w-full touch-none gap-1" style={{ gridTemplateColumns: `repeat(${board.cols}, minmax(0,1fr))` }}>
          {board.cells.flatMap((row, rowIndex) => row.map((cell, col) => {
            const position = { row: rowIndex, col };
            const active = selected?.row === rowIndex && selected.col === col;
            const blocked = !cell.playable || cell.blocker !== null;
            return (
              <motion.button
                layout="position"
                type="button"
                key={`cell-${rowIndex}-${col}`}
                data-row={rowIndex}
                data-col={col}
                data-color={cell.candy?.color}
                data-special={cell.candy?.special}
                disabled={blocked || submitting}
                onPointerDown={event => beginGesture(position, event)}
                onPointerUp={endGesture}
                onPointerCancel={() => { gesture.current = undefined; }}
                onClick={() => handleCellClick(position)}
                aria-label={rankedCellLabel(cell, rowIndex, col, isVi, active, submitting)}
                aria-pressed={active}
                className={`relative flex min-h-0 select-none items-center justify-center rounded-[clamp(.55rem,2.4vw,1rem)] border-2 p-[clamp(2px,1vw,6px)] outline-none transition-shadow focus-visible:ring-4 focus-visible:ring-[#FF7A00] focus-visible:ring-offset-1 ${active ? 'z-20 border-[#FF7A00] bg-white ring-4 ring-[#FFCF4D] shadow-xl' : 'border-white/70 bg-white/45 shadow-sm'} ${blocked ? 'opacity-90' : 'cursor-grab active:cursor-grabbing'}`}
                initial={reduceMotion ? false : { opacity: 0, scale: .72, y: -8 }}
                animate={{ opacity: 1, scale: active ? 1.08 : 1, y: 0 }}
                whileTap={blocked ? undefined : { scale: .9 }}
                transition={reduceMotion ? { duration: 0 } : { layout: { type: 'spring', stiffness: 420, damping: 30 }, opacity: { duration: .18 }, scale: { duration: .16 } }}
              >
                {cell.blocker ? (
                  <span className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-xl border-2 border-amber-950 bg-gradient-to-br from-amber-700 to-amber-950 shadow-inner" aria-hidden>
                    <span className="absolute inset-1 rounded-md border border-amber-500/60" />
                    <span className="text-[clamp(.8rem,4vw,2rem)]">🍫</span>
                  </span>
                ) : cell.occupant ? (
                  <span className="relative flex h-full w-full items-center justify-center rounded-xl bg-gradient-to-b from-amber-200 to-orange-400 text-[clamp(1rem,5vw,2.4rem)] shadow-inner" aria-hidden>🍒<span className="absolute right-0 top-0 text-[9px]">✦</span></span>
                ) : cell.candy ? (
                  <CandyArt color={cell.candy.color} special={cell.candy.special} />
                ) : null}
                {cell.overlay && <span className="pointer-events-none absolute inset-1 rounded-xl border-2 border-cyan-50 bg-cyan-200/40 shadow-[inset_0_0_12px_rgba(255,255,255,.8)]" aria-hidden><svg className="h-full w-full text-white/75" viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 18 50 50 82 30M50 50 38 84M50 50 78 78" /></svg></span>}
              </motion.button>
            );
          }))}
        </div>
      </motion.section>

      <p className="mx-auto mt-3 max-w-xl text-center text-xs font-bold leading-relaxed text-[#6B5A45]">{isVi ? 'Vuốt hoặc chọn hai viên cạnh nhau. Điểm và xếp hạng chỉ được lưu sau khi máy chủ xác nhận toàn bộ nước đi.' : 'Swipe or select two neighbors. Score and rank are saved only after the server verifies every move.'}</p>
      {error && (
        <section role="alert" className="mx-auto mt-3 max-w-xl rounded-2xl border border-red-200 bg-red-50 p-3 text-center text-sm font-bold text-red-700 shadow-sm">
          <p>{error}</p>
          <button type="button" onClick={onBack} className="mt-3 rounded-xl bg-red-600 px-4 py-2 font-black text-white shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700">
            {isVi ? 'Về bản đồ' : 'Return to map'}
          </button>
        </section>
      )}
    </main>
  );
}

function safeVibrate(pattern: number | number[]): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  navigator.vibrate(pattern);
}

function objectiveIcon(kind: EngineObjective['kind']): string {
  return kind === 'score' ? '⭐' : kind === 'clear-ice' ? '❄️' : kind === 'clear-chocolate' ? '🍫' : kind === 'drop-ingredient' ? '🍒' : kind === 'defeat-boss' ? '👑' : '🍬';
}

function rankedCellLabel(cell: BoardCell, row: number, col: number, isVi: boolean, selected: boolean, submitting: boolean): string {
  const parts: string[] = [];
  const colors = isVi
    ? { red: 'đỏ', orange: 'cam', yellow: 'vàng', green: 'xanh lá', blue: 'xanh dương', purple: 'tím' }
    : { red: 'red', orange: 'orange', yellow: 'yellow', green: 'green', blue: 'blue', purple: 'purple' };
  const specials = isVi
    ? { none: '', 'striped-h': 'sọc ngang', 'striped-v': 'sọc dọc', wrapped: 'bom bọc', rainbow: 'cầu vồng' }
    : { none: '', 'striped-h': 'horizontal striped', 'striped-v': 'vertical striped', wrapped: 'wrapped bomb', rainbow: 'rainbow' };

  if (!cell.playable) parts.push(isVi ? 'ô không chơi được' : 'unplayable cell');
  else if (cell.blocker) parts.push(isVi ? `sô-cô-la, ${cell.blocker.hp} lớp` : `chocolate blocker, ${cell.blocker.hp} layer${cell.blocker.hp === 1 ? '' : 's'}`);
  else if (cell.occupant) parts.push(isVi ? 'nguyên liệu cherry' : 'cherry ingredient');
  else if (cell.candy) {
    parts.push(isVi ? `kẹo ${colors[cell.candy.color]}` : `${colors[cell.candy.color]} candy`);
    const special = specials[cell.candy.special];
    if (special) parts.push(special);
  } else parts.push(isVi ? 'ô trống' : 'empty cell');

  if (cell.overlay) parts.push(isVi ? `băng, ${cell.overlay.hp} lớp` : `ice, ${cell.overlay.hp} layer${cell.overlay.hp === 1 ? '' : 's'}`);
  if (selected) parts.push(isVi ? 'đang chọn' : 'selected');
  if (submitting) parts.push(isVi ? 'đang chờ máy chủ' : 'waiting for server');
  parts.push(isVi ? `hàng ${row + 1}, cột ${col + 1}` : `row ${row + 1}, column ${col + 1}`);
  return parts.join(', ');
}
