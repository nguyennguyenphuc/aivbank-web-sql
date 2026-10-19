import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { BoosterType, PlayerInventory } from '../../types/game';
import { soundFx } from '../../utils/audio';
import { useAccessibleDialog } from './HowToPlayModal';
import type { DailyGiftClaimResult, DailyGiftStatus } from '../../../shared/contracts/economy';

interface ShopModalProps {
  inventory: PlayerInventory;
  onBuyBooster: (type: BoosterType, cost: number, count: number, intentKey: string) => Promise<void>;
  onClaimFreeCoins: (day: string) => Promise<DailyGiftClaimResult>;
  onLoadDailyGift: () => Promise<DailyGiftStatus>;
  onClose: () => void;
  language: 'vi' | 'en';
}

export const ShopModal: React.FC<ShopModalProps> = ({
  inventory,
  onBuyBooster,
  onClaimFreeCoins,
  onLoadDailyGift,
  onClose,
  language,
}) => {
  const isVi = language === 'vi';
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [dailyGift, setDailyGift] = useState<DailyGiftStatus>();
  const [giftLoading, setGiftLoading] = useState(true);
  const [giftRefresh, setGiftRefresh] = useState(0);
  const [giftConfirmed, setGiftConfirmed] = useState(false);
  const inFlightRef = useRef(new Set<string>());
  const purchaseIntentKeysRef = useRef(new Map<BoosterType, string>());
  const dialogRef = useAccessibleDialog(onClose, 'btn-close-shop');

  useEffect(() => {
    let active = true;
    setGiftLoading(true);
    setGiftConfirmed(false);
    setError(undefined);
    void onLoadDailyGift().then(status => {
      if (active) setDailyGift(status);
    }).catch(() => {
      if (active) {
        setDailyGift(undefined);
        setError(isVi ? 'Chưa kiểm tra được quà hôm nay. Hãy thử kiểm tra lại.' : 'Could not check today’s gift. Please check again.');
      }
    }).finally(() => {
      if (active) setGiftLoading(false);
    });
    return () => { active = false; };
  }, [onLoadDailyGift, giftRefresh, isVi]);

  useEffect(() => {
    if (!dailyGift) return;
    const timer = window.setTimeout(() => {
      setGiftConfirmed(false);
      setGiftRefresh(value => value + 1);
    }, Math.max(1000, Date.parse(dailyGift.nextClaimAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [dailyGift]);

  const run = async (key: string, operation: () => Promise<void>, onSuccess?: () => void) => {
    if (inFlightRef.current.size > 0) return;
    inFlightRef.current.add(key);
    setPending(key); setError(undefined);
    try {
      await operation();
      onSuccess?.();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : (isVi ? 'Giao dịch thất bại' : 'Transaction failed')); }
    finally {
      inFlightRef.current.delete(key);
      setPending(undefined);
    }
  };

  const shopItems: {
    type: BoosterType;
    icon: string;
    nameVi: string;
    nameEn: string;
    descVi: string;
    descEn: string;
    count: number;
    cost: number;
    bg: string;
  }[] = [
    {
      type: 'hammer',
      icon: '🍭🔨',
      nameVi: 'Búa Kẹo Mút',
      nameEn: 'Lollipop Hammer',
      descVi: 'Đập tan 1 ô kẹo hoặc chướng ngại vật bất kỳ',
      descEn: 'Smash any tile or obstacle immediately',
      count: 2,
      cost: 100,
      bg: 'from-pink-500 to-rose-600',
    },
    {
      type: 'lightning',
      icon: '⚡🌟',
      nameVi: 'Tia Sét Kẹo',
      nameEn: 'Lightning Wand',
      descVi: 'Bắn tia sét xuyên 1 hàng và 1 cột',
      descEn: 'Fire lightning across 1 row & 1 column',
      count: 2,
      cost: 120,
      bg: 'from-amber-400 to-yellow-600',
    },
    {
      type: 'shuffle',
      icon: '🔄✨',
      nameVi: 'Đũa Xáo Trộn',
      nameEn: 'Shuffle Wand',
      descVi: 'Xáo trộn lại toàn bộ kẹo trên bàn cờ',
      descEn: 'Randomize all candies on the grid',
      count: 3,
      cost: 80,
      bg: 'from-cyan-400 to-blue-600',
    },
    {
      type: 'extraMoves',
      icon: '➕5️⃣',
      nameVi: 'Gói +5 Lượt Đi',
      nameEn: '+5 Moves Pack',
      descVi: 'Cứu nguy khi sắp hết lượt di chuyển',
      descEn: 'Extra tactical moves when in danger',
      count: 2,
      cost: 100,
      bg: 'from-emerald-400 to-teal-600',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shop-title"
        aria-describedby="shop-description"
        tabIndex={-1}
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="w-full max-w-md bg-[#FFF9E6] rounded-[2rem] p-5 border-4 border-[#FF9F1A] shadow-[0_8px_0_#E6B800] relative flex flex-col max-h-[90vh] overflow-y-auto text-[#4A3B2C]"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b-2 border-[#FF9F1A]/40">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🏪</span>
            <h3 id="shop-title" className="text-xl font-black text-[#855D00] font-heading">
              {isVi ? 'Cửa Hàng Kẹo Ngọt' : 'Candy Shop'}
            </h3>
          </div>
          <div className="flex items-center gap-3">
            {/* Coins indicator */}
            <div className="flex items-center gap-1 bg-[#FFF1CC] px-3 py-1 rounded-full border-2 border-[#FF9F1A] shadow-inner">
              <span className="text-base">🪙</span>
              <span className="font-black text-[#855D00] text-sm">{inventory.coins}</span>
            </div>
            <button
              id="btn-close-shop"
              aria-label={isVi ? 'Đóng cửa hàng' : 'Close shop'}
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-[#FFF1CC] hover:bg-[#FFE6A6] text-[#855D00] font-black text-sm flex items-center justify-center border border-[#FF9F1A]"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Free coins gift banner */}
        <div id="shop-description" className="my-3 p-3 bg-white rounded-2xl border-2 border-[#88D66C] flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-2">
            <span className="text-3xl animate-bounce">🎁</span>
            <div>
              <p className="text-[#4A7A37] font-black text-xs sm:text-sm">
                {isVi ? 'Quà Tặng Xu Miễn Phí!' : 'Free Daily Bonus!'}
              </p>
              <p className="text-[#3F6F30] text-[11px] font-bold">
                {dailyGift?.claimed
                  ? (isVi ? `Đã nhận hôm nay. Quà mới lúc 00:00 UTC (${dailyGift.nextClaimAt.slice(0, 10)}).` : `Claimed today. Next gift at 00:00 UTC (${dailyGift.nextClaimAt.slice(0, 10)}).`)
                  : (isVi ? 'Mỗi ngày nhận một lần +150 Xu, đặt lại lúc 00:00 UTC' : '150 coins once daily; resets at 00:00 UTC')}
              </p>
            </div>
          </div>
          <button
            id="btn-claim-free-coins"
            disabled={Boolean(pending) || giftLoading || dailyGift?.claimed}
            aria-busy={giftLoading || pending === 'daily-gift'}
            onClick={() => {
              if (!dailyGift) {
                setGiftRefresh(value => value + 1);
                return;
              }
              void run('daily-gift', async () => {
                try {
                  const result = await onClaimFreeCoins(dailyGift.day);
                  setDailyGift(result.dailyGift);
                  setGiftConfirmed(true);
                  soundFx.playSpecialCreated();
                } catch (cause) {
                  // Retrying uses the same server day/key, including after a lost response.
                  throw new Error(isVi
                    ? 'Chưa xác nhận được giao dịch. Thử lại an toàn, quà chỉ được cộng một lần mỗi ngày.'
                    : 'Could not confirm the claim. Retry safely; the gift is credited only once per day.', { cause });
                }
              });
            }}
            className="px-3.5 py-1.5 bg-[#3F6F30] hover:bg-[#315A23] text-white rounded-xl font-black text-xs border-b-2 border-[#274A1C] shadow active:scale-95 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {giftLoading ? (isVi ? 'Đang kiểm tra…' : 'Checking…')
              : pending === 'daily-gift' ? (isVi ? 'Đang nhận…' : 'Claiming…')
              : dailyGift?.claimed ? (isVi ? 'Đã nhận hôm nay' : 'Claimed today')
              : !dailyGift ? (isVi ? 'Kiểm tra lại' : 'Check again')
              : (isVi ? 'Nhận +150' : 'Claim +150')}
          </button>
        </div>
        {error && <p role="alert" className="mb-2 rounded-xl bg-red-50 p-2 text-center text-xs font-bold text-red-700">{error}</p>}
        {error && dailyGift && <button
          type="button"
          disabled={Boolean(pending) || giftLoading}
          onClick={() => setGiftRefresh(value => value + 1)}
          className="mb-2 text-xs font-bold underline disabled:opacity-60"
        >{isVi ? 'Kiểm tra và đồng bộ lại quà' : 'Check and synchronize gift again'}</button>}
        {giftConfirmed && <p role="status" className="mb-2 rounded-xl bg-green-50 p-2 text-center text-xs font-bold text-green-800">
          {isVi ? 'Quà hôm nay đã được nhận. Số dư đã đồng bộ với máy chủ.' : 'Today’s gift is claimed. Balance synchronized with the server.'}
        </p>}

        {/* Item List */}
        <div className="grid grid-cols-1 gap-2.5 my-2">
          {shopItems.map(item => {
            const currentOwned = inventory.boosters[item.type] || 0;
            const canAfford = inventory.coins >= item.cost;

            return (
              <div
                key={item.type}
                className="bg-white p-3 rounded-2xl border-2 border-[#FF9F1A]/60 shadow-sm flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-12 h-12 rounded-2xl bg-[#FFF1CC] text-slate-800 flex items-center justify-center text-2xl shadow border-2 border-[#FF9F1A]"
                  >
                    {item.icon}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-black text-[#855D00] text-sm">
                        {isVi ? item.nameVi : item.nameEn}
                      </span>
                      <span className="text-[10px] bg-[#FFF1CC] text-[#855D00] px-1.5 py-0.5 rounded-full font-bold border border-[#FF9F1A]">
                        x{item.count}
                      </span>
                    </div>
                    <p className="text-[#6B4F00] text-[11px] mt-0.5 leading-tight font-semibold">
                      {isVi ? item.descVi : item.descEn}
                    </p>
                    <span className="text-[10px] text-slate-500 font-semibold">
                      {isVi ? `Đang có: ${currentOwned}` : `Owned: ${currentOwned}`}
                    </span>
                  </div>
                </div>

                <motion.button
                  id={`btn-buy-${item.type}`}
                  whileHover={{ scale: canAfford ? 1.05 : 1 }}
                  whileTap={{ scale: canAfford ? 0.95 : 1 }}
                  disabled={!canAfford || Boolean(pending)}
                  onClick={() => {
                    const intentKey = purchaseIntentKeysRef.current.get(item.type) ?? crypto.randomUUID();
                    purchaseIntentKeysRef.current.set(item.type, intentKey);
                    void run(item.type, async () => {
                    if (canAfford) {
                      soundFx.playSpecialCreated();
                      await onBuyBooster(item.type, item.cost, item.count, intentKey);
                    }
                    }, () => purchaseIntentKeysRef.current.delete(item.type));
                  }}
                  className={`px-3 py-2 rounded-xl font-black text-xs flex items-center gap-1 shadow whitespace-nowrap ${
                    canAfford
                      ? 'bg-[#FF7A00] hover:bg-[#FF8C1A] text-white border-b-2 border-[#CC6200]'
                      : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  <span>🪙</span>
                  <span>{item.cost} Xu</span>
                </motion.button>
              </div>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
};
