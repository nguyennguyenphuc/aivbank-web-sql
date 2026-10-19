import React, { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { Objective } from '../../types/game';
import { soundFx } from '../../utils/audio';
import { useAccessibleDialog } from './HowToPlayModal';

interface DefeatModalProps {
  levelId: number;
  objectives: Objective[];
  hasExtraMovesBooster: boolean;
  canBuyExtraMoves: boolean;
  playerCoins: number;
  onUseExtraMoves: (intentKey: string) => Promise<void>;
  onBuyExtraMoves: (intentKey: string) => Promise<void>;
  onRetry: () => void;
  onBackToMap: () => void;
  onInspect: () => void;
  language: 'vi' | 'en';
}

export const DefeatModal: React.FC<DefeatModalProps> = ({
  levelId,
  objectives,
  hasExtraMovesBooster,
  canBuyExtraMoves,
  playerCoins,
  onUseExtraMoves,
  onBuyExtraMoves,
  onRetry,
  onBackToMap,
  onInspect,
  language,
}) => {
  const isVi = language === 'vi';
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inFlightRef = useRef(false);
  const intentKeysRef = useRef<Partial<Record<'booster' | 'purchase', string>>>({});
  const dialogRef = useAccessibleDialog(() => { if (!pending) onBackToMap(); }, 'btn-defeat-retry');

  const runContinuation = async (kind: 'booster' | 'purchase', operation: (intentKey: string) => Promise<void>) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const intentKey = intentKeysRef.current[kind] ?? crypto.randomUUID();
    intentKeysRef.current[kind] = intentKey;
    setPending(true);
    setError(null);
    try {
      await operation(intentKey);
      delete intentKeysRef.current[kind];
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : (isVi ? 'Không thể tiếp tục màn chơi' : 'Could not continue the level'));
    } finally {
      inFlightRef.current = false;
      setPending(false);
    }
  };

  useEffect(() => {
    soundFx.playDefeat();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="defeat-title"
        aria-describedby="defeat-description"
        aria-busy={pending}
        tabIndex={-1}
        initial={{ scale: 0.7, opacity: 0, y: 30 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: 'spring', damping: 18 }}
        className="w-full max-w-sm bg-[#FFF9E6] rounded-[2rem] p-6 border-4 border-[#FF9F1A] shadow-[0_8px_0_#E6B800] text-center relative overflow-hidden text-[#4A3B2C]"
      >
        {/* Banner */}
        <h2 id="defeat-title" className="absolute -top-1 left-1/2 -translate-x-1/2 bg-[#C2410C] text-white font-black text-lg px-8 py-2 rounded-b-2xl shadow-md border-b-4 border-[#9A3412]">
          {isVi ? '💔 HẾT LƯỢT ĐI!' : '💔 OUT OF MOVES!'}
        </h2>

        <div id="defeat-description" className="mt-8 flex flex-col items-center">
          {/* Sad Mascot */}
          <div className="my-2 relative">
            <span className="text-6xl select-none filter drop-shadow-md">🥺🍬</span>
          </div>

          <p className="text-[#855D00] font-black text-sm mt-1">
            {isVi ? 'Bạn đã rất cố gắng! Chỉ còn một chút nữa thôi!' : 'So close! You almost completed the goals!'}
          </p>

          {/* Remaining Objectives checklist */}
          <div className="w-full my-3 bg-white p-3 rounded-2xl border-2 border-[#88D66C] shadow-sm flex flex-col gap-1.5 text-left">
            <span className="text-[#4A7A37] font-black text-[11px] uppercase tracking-wider">
              {isVi ? 'Mục tiêu chưa đạt:' : 'Remaining Goals:'}
            </span>
            {objectives.map((obj, i) => {
              const isDone = obj.current >= obj.target;
              return (
                <div key={i} className="flex items-center justify-between text-xs font-bold bg-[#F0FFF0] p-1.5 rounded-xl border border-[#88D66C]/40">
                  <span className="text-[#4A7A37] flex items-center gap-1">
                    <span>{isDone ? '✅' : '⏳'}</span>
                    <span>{isVi ? obj.descriptionVi : obj.descriptionEn}</span>
                  </span>
                  <span className={`font-black ${isDone ? 'text-[#4A7A37]' : 'text-[#FF7A00]'}`}>
                    {obj.current} / {obj.target}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Continue with +5 Moves Option */}
          {(hasExtraMovesBooster || canBuyExtraMoves) && <div className="w-full my-2 p-3 bg-[#FFF1CC] rounded-2xl border-2 border-[#FF9F1A] shadow-sm flex flex-col gap-2">
            <span className="text-[#855D00] font-black text-xs">
              {isVi ? 'Tiếp tục chơi với +5 Lượt Đi?' : 'Continue with +5 Extra Moves?'}
            </span>

            {hasExtraMovesBooster ? (
              <motion.button
                id="btn-defeat-use-booster"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.96 }}
                disabled={pending}
                onClick={() => void runContinuation('booster', onUseExtraMoves)}
                className="w-full py-2.5 bg-[#3F6F30] hover:bg-[#315A23] disabled:opacity-60 disabled:cursor-not-allowed text-white font-black text-sm rounded-xl border-b-4 border-[#274A1C] shadow flex items-center justify-center gap-1.5 active:translate-y-0.5"
              >
                <span>➕5️⃣</span>
                <span>{pending ? (isVi ? 'Đang dùng…' : 'Using…') : (isVi ? 'Dùng Bổ Trợ (+5 Lượt)' : 'Use Booster (+5 Moves)')}</span>
              </motion.button>
            ) : canBuyExtraMoves ? (
              <motion.button
                id="btn-defeat-buy-moves"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.96 }}
                disabled={pending || playerCoins < 80}
                onClick={() => void runContinuation('purchase', onBuyExtraMoves)}
                className={`w-full py-2.5 bg-[#FF7A00] hover:bg-[#FF8C1A] text-white font-black text-sm rounded-xl border-b-4 border-[#CC6200] shadow flex items-center justify-center gap-1.5 active:translate-y-0.5 ${
                  playerCoins < 80 ? 'opacity-60 cursor-not-allowed' : ''
                }`}
              >
                <span>➕5️⃣</span>
                <span>{pending ? (isVi ? 'Đang mua…' : 'Buying…') : (isVi ? 'Mua +5 Lượt (80 Xu)' : 'Buy +5 Moves (80 Coins)')}</span>
              </motion.button>
            ) : null}
          </div>}
          {error && <p role="alert" className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-700">{error}</p>}

          {/* Retry or Map */}
          <div className="flex gap-2 w-full mt-2">
            <button
              id="btn-defeat-retry"
              disabled={pending}
              onClick={() => { if (!inFlightRef.current) onRetry(); }}
              className="flex-1 py-2.5 bg-[#FF7A00] hover:bg-[#FF8C1A] disabled:cursor-not-allowed disabled:opacity-60 text-white font-black text-sm rounded-2xl border-b-4 border-[#CC6200] shadow active:translate-y-1 transition-all"
            >
              {isVi ? '🔄 Thử Lại' : '🔄 Retry'}
            </button>
            <button
              id="btn-defeat-map"
              disabled={pending}
              onClick={() => { if (!inFlightRef.current) onBackToMap(); }}
              className="flex-1 py-2.5 bg-white disabled:cursor-not-allowed disabled:opacity-60 text-[#855D00] font-black text-sm rounded-2xl hover:bg-[#FFF1CC] active:scale-95 transition-all border-2 border-[#FF9F1A] shadow-[0_3px_0_#FF9F1A]"
            >
              {isVi ? '🗺️ Bản Đồ' : '🗺️ Map'}
            </button>
          </div>
          <button disabled={pending} onClick={() => { if (!inFlightRef.current) onInspect(); }} className="mt-3 min-h-11 w-full rounded-2xl border-2 border-teal-200 bg-teal-50 px-4 py-3 text-sm font-bold text-teal-900 hover:bg-teal-100 disabled:opacity-60 focus-visible:outline-4 focus-visible:outline-teal-600">
            {isVi ? 'Đọc dữ liệu lượt này' : 'Inspect this attempt'}
          </button>
        </div>
      </motion.div>
    </div>
  );
};
