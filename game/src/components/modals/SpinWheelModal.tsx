import React, { useState } from 'react';
import { motion } from 'motion/react';
import confetti from 'canvas-confetti';
import { BoosterType } from '../../types/game';
import { soundFx } from '../../utils/audio';
import { useAccessibleDialog } from './HowToPlayModal';

interface SpinWheelModalProps {
  onSpin: () => Promise<{ coins: number; booster?: BoosterType; boosterCount?: number }>;
  onClaimReward: () => void;
  onClose: () => void;
  canFreeSpin: boolean;
  language: 'vi' | 'en';
}

interface Prize {
  labelVi: string;
  labelEn: string;
  icon: string;
  coins: number;
  booster?: BoosterType;
  boosterCount?: number;
  color: string;
}

const PRIZES: Prize[] = [
  { labelVi: '+50 Xu', labelEn: '+50 Coins', icon: '🪙', coins: 50, color: '#F59E0B' },
  { labelVi: 'Búa Mút', labelEn: 'Hammer', icon: '🔨', coins: 0, booster: 'hammer', boosterCount: 1, color: '#EC4899' },
  { labelVi: '+100 Xu', labelEn: '+100 Coins', icon: '💰', coins: 100, color: '#10B981' },
  { labelVi: '+5 Lượt', labelEn: '+5 Moves', icon: '➕5️⃣', coins: 0, booster: 'extraMoves', boosterCount: 1, color: '#3B82F6' },
  { labelVi: 'Đũa Xáo', labelEn: 'Shuffle', icon: '🔄', coins: 0, booster: 'shuffle', boosterCount: 1, color: '#8B5CF6' },
  { labelVi: '+250 Xu', labelEn: '+250 Coins', icon: '💎', coins: 250, color: '#F97316' },
  { labelVi: 'Tia Sét', labelEn: 'Lightning', icon: '⚡', coins: 0, booster: 'lightning', boosterCount: 1, color: '#EAB308' },
  { labelVi: 'JACKPOT! 500 Xu', labelEn: 'JACKPOT 500', icon: '👑', coins: 500, color: '#EF4444' },
];

export const SpinWheelModal: React.FC<SpinWheelModalProps> = ({
  onClaimReward,
  onSpin,
  onClose,
  canFreeSpin,
  language,
}) => {
  const isVi = language === 'vi';
  const [isSpinning, setIsSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [wonPrize, setWonPrize] = useState<Prize | null>(null);
  const [error, setError] = useState<string>();
  const dialogRef = useAccessibleDialog(() => { if (!isSpinning) onClose(); }, 'btn-close-spin');

  const spin = async () => {
    if (isSpinning || !canFreeSpin) return;
    setIsSpinning(true);
    setWonPrize(null);
    setError(undefined);
    soundFx.playSwap();

    let reward: Awaited<ReturnType<SpinWheelModalProps['onSpin']>>;
    try {
      reward = await onSpin();
    } catch (cause) {
      setIsSpinning(false);
      setError(cause instanceof Error ? cause.message : (isVi ? 'Không thể quay thưởng' : 'Unable to spin'));
      return;
    }
    const prizeIndex = Math.max(0, PRIZES.findIndex(prize => reward.booster
      ? prize.booster === reward.booster && prize.boosterCount === reward.boosterCount
      : prize.coins === reward.coins));
    const segmentAngle = 360 / PRIZES.length;
    // Calculate final rotation (minimum 5 full spins = 1800 deg)
    // Needle is at top (0 deg). Segment center = 360 - (prizeIndex * segmentAngle + segmentAngle/2)
    const targetSegmentOffset = 360 - (prizeIndex * segmentAngle + segmentAngle / 2);
    const extraSpins = 360 * 6; // 6 full rotations
    const finalRotation = rotation + extraSpins + targetSegmentOffset - (rotation % 360);

    setRotation(finalRotation);

    setTimeout(() => {
      setIsSpinning(false);
      const prize = PRIZES[prizeIndex];
      setWonPrize(prize);
      soundFx.playSpecialCreated();
      try {
        confetti({
          particleCount: 60,
          spread: 60,
          origin: { y: 0.6 },
        });
      } catch {
        // ignore
      }
    }, 4200);
  };

  const handleClaim = () => {
    if (wonPrize) {
      onClaimReward();
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="spin-title"
        aria-describedby="spin-description"
        tabIndex={-1}
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="w-full max-w-sm bg-[#FFF9E6] rounded-[2rem] p-5 border-4 border-[#FF9F1A] shadow-[0_8px_0_#E6B800] text-center relative flex flex-col items-center text-[#4A3B2C]"
      >
        {/* Close button */}
        <button
          id="btn-close-spin"
          aria-label={isVi ? 'Đóng vòng quay' : 'Close spin wheel'}
          onClick={onClose}
          disabled={isSpinning}
          className="absolute top-3 right-3 w-8 h-8 rounded-full bg-[#FFF1CC] hover:bg-[#FFE6A6] text-[#855D00] font-black text-sm flex items-center justify-center border border-[#FF9F1A]"
        >
          ✕
        </button>

        <h3 id="spin-title" className="text-xl font-black text-[#855D00] mb-1 flex items-center gap-2 font-heading">
          <span>🎡</span>
          <span>{isVi ? 'Vòng Quay May Mắn' : 'Lucky Daily Spin'}</span>
        </h3>
        <p id="spin-description" className="text-xs text-[#855D00] font-bold mb-4">
          {isVi ? 'Quay mỗi ngày để nhận xu vàng và bổ trợ kẹo miễn phí!' : 'Spin daily for free coins and magic boosters!'}
        </p>

        {/* Wheel Container */}
        <div className="relative w-64 h-64 my-2 flex items-center justify-center">
          {/* Wheel Pointer Needle */}
          <div className="absolute -top-3 z-30 filter drop-shadow-md">
            <div className="w-0 h-0 border-l-[14px] border-l-transparent border-r-[14px] border-r-transparent border-t-[24px] border-t-[#FF7A00]"></div>
          </div>

          {/* Rotating Wheel */}
          <div
            className="w-full h-full rounded-full border-4 border-[#FF9F1A] shadow-xl overflow-hidden relative"
            style={{
              transform: `rotate(${rotation}deg)`,
              transition: isSpinning ? 'transform 4.2s cubic-bezier(0.15, 0.9, 0.2, 1)' : 'none',
            }}
          >
            {PRIZES.map((prize, idx) => {
              const angle = (360 / PRIZES.length) * idx;
              return (
                <div
                  key={idx}
                  className="absolute top-0 left-0 w-full h-full origin-center flex justify-center pt-2"
                  style={{
                    transform: `rotate(${angle}deg)`,
                  }}
                >
                  <div
                    className="w-0 h-0 border-l-[52px] border-l-transparent border-r-[52px] border-r-transparent border-t-[128px] absolute top-0 origin-bottom"
                    style={{ borderTopColor: prize.color }}
                  ></div>
                  <div className="relative z-10 flex flex-col items-center pt-2 text-white font-black text-[11px] select-none">
                    <span className="text-lg filter drop-shadow">{prize.icon}</span>
                    <span className="drop-shadow-sm text-[10px] mt-0.5 whitespace-nowrap">
                      {isVi ? prize.labelVi : prize.labelEn}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Center Hub Button */}
          <div className="absolute z-20 w-14 h-14 rounded-full bg-[#FFCF4D] border-4 border-white shadow-lg flex items-center justify-center">
            <span className="text-xl">⭐</span>
          </div>
        </div>

        {/* Won Prize Banner */}
        {wonPrize && (
          <motion.div
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="my-3 p-3 bg-white rounded-2xl border-2 border-[#88D66C] shadow-md flex flex-col items-center"
          >
            <span className="text-xs font-bold text-[#4A7A37]">{isVi ? 'Chúc mừng bạn trúng thưởng:' : 'You won:'}</span>
            <span className="text-lg font-black text-[#855D00] flex items-center gap-1.5 mt-1">
              <span>{wonPrize.icon}</span>
              <span>{isVi ? wonPrize.labelVi : wonPrize.labelEn}</span>
            </span>
          </motion.div>
        )}

        {/* Spin / Claim Button */}
        <div className="w-full mt-3">
          {error && <p role="alert" className="mb-3 rounded-xl bg-red-50 p-2 text-xs font-bold text-red-700">{error}</p>}
          {wonPrize ? (
            <motion.button
              id="btn-claim-spin"
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleClaim}
              className="w-full py-3 bg-[#3F6F30] hover:bg-[#315A23] text-white font-black text-base rounded-2xl border-b-4 border-[#274A1C] shadow-lg active:translate-y-1 transition-all"
            >
              {isVi ? '🎁 Nhận Thưởng Ngay' : '🎁 Claim Reward'}
            </motion.button>
          ) : (
            <motion.button
              id="btn-start-spin"
              whileHover={{ scale: isSpinning ? 1 : 1.03 }}
              whileTap={{ scale: isSpinning ? 1 : 0.95 }}
              disabled={isSpinning || !canFreeSpin}
              onClick={spin}
              className={`w-full py-3 bg-[#FF7A00] hover:bg-[#FF8C1A] text-white font-black text-base rounded-2xl border-b-4 border-[#CC6200] shadow-lg active:translate-y-1 transition-all ${
                isSpinning ? 'opacity-70 cursor-not-allowed' : ''
              }`}
            >
              {isSpinning
                ? (isVi ? 'Đang quay...' : 'Spinning...')
                : (canFreeSpin ? (isVi ? '🎲 Quay Miễn Phí!' : '🎲 Free Spin!') : (isVi ? 'Đã quay hôm nay' : 'Already spun today'))}
            </motion.button>
          )}
        </div>
      </motion.div>
    </div>
  );
};
