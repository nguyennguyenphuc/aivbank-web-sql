import React, { useEffect } from 'react';
import { motion } from 'motion/react';
import confetti from 'canvas-confetti';
import { soundFx } from '../../utils/audio';
import { useAccessibleDialog } from './HowToPlayModal';

interface VictoryModalProps {
  levelId: number;
  score: number;
  stars: number;
  coinsEarned: number;
  isNewRecord: boolean;
  hasNextLevel: boolean;
  onNextLevel: () => void;
  onReplay: () => void;
  onBackToMap: () => void;
  onInspect: () => void;
  language: 'vi' | 'en';
}

export const VictoryModal: React.FC<VictoryModalProps> = ({
  levelId,
  score,
  stars,
  coinsEarned,
  isNewRecord,
  hasNextLevel,
  onNextLevel,
  onReplay,
  onBackToMap,
  onInspect,
  language,
}) => {
  const isVi = language === 'vi';
  const dialogRef = useAccessibleDialog(onBackToMap, 'btn-victory-next-level');

  useEffect(() => {
    soundFx.playVictory();
    // Confetti cannon
    try {
      confetti({
        particleCount: 100,
        spread: 80,
        origin: { y: 0.5 },
        colors: ['#F43F5E', '#FBBF24', '#34D399', '#60A5FA', '#A78BFA'],
        disableForReducedMotion: true,
      });
    } catch {
      // fallback
    }

    // Play star sounds sequentially
    const timeouts = [
      setTimeout(() => soundFx.playStar(0), 400),
      setTimeout(() => { if (stars >= 2) soundFx.playStar(1); }, 800),
      setTimeout(() => { if (stars >= 3) soundFx.playStar(2); }, 1200),
    ];

    return () => {
      timeouts.forEach(clearTimeout);
    };
  }, [stars]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="victory-title"
        aria-describedby="victory-description"
        tabIndex={-1}
        initial={{ scale: 0.7, opacity: 0, y: 30 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: 'spring', damping: 18 }}
        className="w-full max-w-sm bg-[#FFF9E6] rounded-[2rem] p-6 border-4 border-[#FF9F1A] shadow-[0_8px_0_#E6B800] text-center relative overflow-hidden text-[#4A3B2C]"
      >
        {/* Top Banner Ribbon */}
        <h2 id="victory-title" className="absolute -top-1 left-1/2 -translate-x-1/2 bg-[#4A7A37] text-white font-black text-lg sm:text-xl px-8 py-2 rounded-b-2xl shadow-md border-b-4 border-[#315A23]">
          {isVi ? '🎉 CHIẾN THẮNG!' : '🎉 LEVEL CLEARED!'}
        </h2>

        <div id="victory-description" className="mt-8 flex flex-col items-center">
          {/* Animated 3 Stars */}
          <div className="flex items-center justify-center gap-3 my-4">
            {[1, 2, 3].map((starNum, idx) => {
              const isEarned = stars >= starNum;
              return (
                <motion.div
                  key={starNum}
                  initial={{ scale: 0, rotate: -30 }}
                  animate={{ scale: isEarned ? 1 : 0.8, rotate: 0 }}
                  transition={{ delay: 0.3 + idx * 0.35, type: 'spring' }}
                  className={`relative flex items-center justify-center ${
                    starNum === 2 ? 'mb-4' : ''
                  }`}
                >
                  <span
                    className={`text-5xl sm:text-6xl filter drop-shadow-md select-none transition-all ${
                      isEarned ? 'opacity-100 scale-110' : 'opacity-30 grayscale'
                    }`}
                  >
                    ⭐
                  </span>
                </motion.div>
              );
            })}
          </div>

          <p className="text-[#855D00] font-black text-sm">
            {isVi ? `Màn ${levelId} hoàn thành xuất sắc!` : `Level ${levelId} completed!`}
          </p>

          {/* Score & Coins Badge */}
          <div className="w-full my-4 bg-white p-3 rounded-2xl border-2 border-[#88D66C] shadow-sm flex flex-col gap-2">
            <div className="flex items-center justify-between px-2">
              <span className="text-[#4A7A37] font-bold text-xs">{isVi ? 'Tổng Điểm:' : 'Total Score:'}</span>
              <span className="text-xl font-black text-[#FF7A00]">
                {score.toLocaleString()}
                {isNewRecord && (
                  <span className="ml-1 text-[10px] bg-[#FF7A00] text-white px-1.5 py-0.5 rounded-full font-black">
                    {isVi ? 'KỶ LỤC!' : 'RECORD!'}
                  </span>
                )}
              </span>
            </div>
            <div className="flex items-center justify-between px-2 border-t border-[#88D66C]/40 pt-2">
              <span className="text-[#4A7A37] font-bold text-xs">{isVi ? 'Thưởng Xu:' : 'Coins Earned:'}</span>
              <span className="text-base font-black text-[#855D00] flex items-center gap-1">
                <span>🪙</span> +{coinsEarned}
              </span>
            </div>
          </div>

          {/* Actions */}
          <div className="w-full flex flex-col gap-2.5 mt-2">
            {hasNextLevel && (
              <motion.button
                id="btn-victory-next-level"
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.95 }}
                onClick={onNextLevel}
                className="w-full py-3 bg-[#3F6F30] hover:bg-[#315A23] text-white font-black text-base rounded-2xl border-b-4 border-[#274A1C] shadow-lg flex items-center justify-center gap-2 active:translate-y-1 transition-all"
              >
                <span>{isVi ? 'Màn Tiếp Theo' : 'Next Level'}</span>
                <span>➡️</span>
              </motion.button>
            )}

            <div className="flex gap-2 w-full">
              <button
                id="btn-victory-replay"
                onClick={onReplay}
                className="flex-1 py-2.5 bg-[#FFF1CC] text-[#855D00] font-black text-sm rounded-2xl hover:bg-[#FFE6A6] active:scale-95 transition-all border-2 border-[#FF9F1A] shadow-[0_3px_0_#FF9F1A]"
              >
                {isVi ? '🔄 Chơi Lại' : '🔄 Replay'}
              </button>
              <button
                id="btn-victory-map"
                onClick={onBackToMap}
                className="flex-1 py-2.5 bg-white text-[#855D00] font-black text-sm rounded-2xl hover:bg-[#FFF1CC] active:scale-95 transition-all border-2 border-[#FF9F1A] shadow-[0_3px_0_#FF9F1A]"
              >
                {isVi ? '🗺️ Bản Đồ' : '🗺️ Map'}
              </button>
            </div>
            <button onClick={onInspect} className="min-h-11 rounded-2xl border-2 border-teal-200 bg-teal-50 px-4 py-3 text-sm font-bold text-teal-900 hover:bg-teal-100 focus-visible:outline-4 focus-visible:outline-teal-600">
              {isVi ? 'Đọc dữ liệu lượt này' : 'Inspect this attempt'}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
};
