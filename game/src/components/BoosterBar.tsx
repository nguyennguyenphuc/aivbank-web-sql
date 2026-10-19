import React from 'react';
import { motion } from 'motion/react';
import { BoosterType, PlayerInventory } from '../types/game';

interface BoosterBarProps {
  inventory: PlayerInventory;
  activeBooster: BoosterType | null;
  onSelectBooster: (booster: BoosterType | null) => void;
  onOpenShop: () => void;
  language: 'vi' | 'en';
  disabled?: boolean;
}

export const BoosterBar: React.FC<BoosterBarProps> = ({
  inventory,
  activeBooster,
  onSelectBooster,
  onOpenShop,
  language,
  disabled,
}) => {
  const isVi = language === 'vi';

  const boosterList: {
    type: BoosterType;
    icon: string;
    name: string;
    desc: string;
    bg: string;
  }[] = [
    {
      type: 'hammer',
      icon: '🍭🔨',
      name: isVi ? 'Búa Kẹo Mút' : 'Lollipop Hammer',
      desc: isVi ? 'Phá huỷ 1 ô kẹo bất kỳ' : 'Smash any single tile',
      bg: 'from-pink-500 to-rose-600',
    },
    {
      type: 'lightning',
      icon: '⚡🌟',
      name: isVi ? 'Tia Sét Kẹo' : 'Lightning Strike',
      desc: isVi ? 'Bắn nát 1 hàng và 1 cột' : 'Blast 1 row & 1 column',
      bg: 'from-amber-400 to-yellow-600',
    },
    {
      type: 'shuffle',
      icon: '🔄✨',
      name: isVi ? 'Đũa Hoán Đổi' : 'Shuffle Wand',
      desc: isVi ? 'Xáo trộn lại toàn bộ bàn cờ' : 'Shuffle all candies',
      bg: 'from-cyan-400 to-blue-600',
    },
    {
      type: 'extraMoves',
      icon: '➕5️⃣',
      name: isVi ? '+5 Lượt' : '+5 Moves',
      desc: isVi ? 'Tăng ngay 5 lượt di chuyển' : 'Add 5 extra moves',
      bg: 'from-emerald-400 to-teal-600',
    },
  ];

  return (
    <div className="w-full max-w-lg mx-auto flex flex-col items-center">
      {/* Active Booster Prompt Banner */}
      {activeBooster && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-2 px-4 py-1.5 bg-[#FFCF4D] text-[#855D00] font-black text-xs sm:text-sm rounded-full shadow-[0_3px_0_#FF9F1A] border-2 border-[#FF9F1A] flex items-center gap-2 animate-bounce"
        >
          <span>✨</span>
          <span>
            {activeBooster === 'hammer' && (isVi ? 'Chạm vào 1 ô trên bàn cờ để đập vỡ!' : 'Tap any tile on the board to smash it!')}
            {activeBooster === 'lightning' && (isVi ? 'Chạm vào ô tâm điểm để phóng tia sét!' : 'Tap a center tile to unleash lightning!')}
          </span>
          <button
            id="btn-cancel-booster"
            onClick={() => onSelectBooster(null)}
            className="ml-2 px-2.5 py-0.5 bg-[#FF7A00] text-white rounded-full text-xs font-black hover:bg-[#CC6200] active:scale-95 shadow border border-white"
          >
            {isVi ? 'Huỷ' : 'Cancel'}
          </button>
        </motion.div>
      )}

      {/* Boosters Row */}
      <div className="flex items-center justify-center gap-2.5 sm:gap-4 bg-[#EDF5F2] p-2 sm:p-3 rounded-[2rem] border-2 border-[#BDD7D3] shadow-[0_3px_0_#BDD7D3]">
        {boosterList.map(b => {
          const count = inventory.boosters[b.type] || 0;
          const isActive = activeBooster === b.type;

          return (
            <motion.button
              key={b.type}
              id={`btn-booster-${b.type}`}
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.92 }}
              disabled={disabled}
              onClick={() => {
                if (count <= 0) {
                  onOpenShop();
                  return;
                }
                if (isActive) {
                  onSelectBooster(null);
                } else {
                  onSelectBooster(b.type);
                }
              }}
              title={`${b.name}: ${b.desc}`}
              aria-label={`${b.name}: ${count > 0 ? (isVi ? `còn ${count}` : `${count} remaining`) : (isVi ? 'mở cửa hàng' : 'open shop')}`}
              aria-pressed={isActive}
              className={`relative flex flex-col items-center justify-center w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-white text-slate-800 shadow-[0_3px_0_#BDD7D3] border-2 border-[#BDD7D3] transition-colors ${
                isActive ? 'ring-2 ring-[#127C82] ring-offset-2 bg-[#E5F4EF]' : ''
              } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <span className="text-xl sm:text-2xl filter drop-shadow-sm select-none">{b.icon}</span>

              {/* Badge count or Plus */}
              {count > 0 ? (
                <span className="absolute -top-2 -right-2 bg-[#216F73] text-white text-[11px] font-black w-6 h-6 rounded-full border-2 border-white flex items-center justify-center shadow-md">
                  {count}
                </span>
              ) : (
                <span className="absolute -top-2 -right-2 bg-[#88D66C] text-white text-[11px] font-black w-6 h-6 rounded-full border-2 border-white flex items-center justify-center shadow-md">
                  +
                </span>
              )}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
};
