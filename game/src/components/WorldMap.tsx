import React, { useState } from 'react';
import { motion } from 'motion/react';
import { LevelConfig, PlayerInventory } from '../types/game';
import { LEVELS, WORLDS } from '../data/levels';
import { soundFx } from '../utils/audio';
import { MetaOverview } from '../features/events/meta-overview';

interface WorldMapProps {
  inventory: PlayerInventory;
  onSelectLevel: (level: LevelConfig) => void;
  onStartPracticeLevel: (level: LevelConfig) => void;
  onOpenSpinWheel: () => void;
  onOpenShop: () => void;
  onOpenHowToPlay: () => void;
  onOpenSettings: () => void;
  language: 'vi' | 'en';
}

export const WorldMap: React.FC<WorldMapProps> = ({
  inventory,
  onSelectLevel,
  onStartPracticeLevel,
  onOpenSpinWheel,
  onOpenShop,
  onOpenHowToPlay,
  onOpenSettings,
  language,
}) => {
  const isVi = language === 'vi';
  const [selectedWorldId, setSelectedWorldId] = useState<number>(() => {
    // Default to the world containing the highest unlocked level
    const curr = inventory.unlockedLevel;
    if (curr <= 6) return 1;
    if (curr <= 12) return 2;
    if (curr <= 18) return 3;
    return 4;
  });

  const [previewLevel, setPreviewLevel] = useState<LevelConfig | null>(null);

  const selectedWorld = WORLDS.find(w => w.id === selectedWorldId) || WORLDS[0];
  const worldLevels = LEVELS.filter(l => l.worldId === selectedWorldId);

  // Total stars calculation
  const totalStars = Object.values(inventory.starsPerLevel).reduce((acc: number, s: number) => acc + s, 0);
  const maxPossibleStars = LEVELS.length * 3;
  const rankedUnlocked = inventory.unlockedLevel >= 4;
  const economyUnlocked = inventory.unlockedLevel >= 5;
  const liveOpsUnlocked = inventory.unlockedLevel >= 6;
  const worldsUnlocked = inventory.unlockedLevel >= 7;

  return (
    <div className="academy-world-map min-h-screen w-full bg-[#FFF9E6] flex flex-col items-center pb-12 select-none relative overflow-x-hidden text-[#4A3B2C]">
      {/* Floating decorative natural elements in background */}
      <div className="absolute top-10 left-6 text-3xl opacity-30 animate-float pointer-events-none">🍬</div>
      <div className="absolute top-40 right-8 text-4xl opacity-30 animate-float pointer-events-none" style={{ animationDelay: '1.5s' }}>🍭</div>
      <div className="absolute top-96 left-8 text-3xl opacity-25 animate-float pointer-events-none" style={{ animationDelay: '0.8s' }}>🍓</div>
      <div className="absolute bottom-20 right-10 text-4xl opacity-25 animate-float pointer-events-none" style={{ animationDelay: '2s' }}>🍒</div>

      {/* TOP HEADER */}
      <header className="w-full max-w-4xl px-4 py-3 sticky top-0 z-40 bg-[#FFCF4D] border-b-4 border-[#E6B800] shadow-sm flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 sm:w-14 sm:h-14 bg-white rounded-2xl flex items-center justify-center border-4 border-[#FF9F1A] shadow-[0_4px_0_#FF9F1A] shrink-0">
            <span className="text-2xl sm:text-3xl animate-bounce">🍬</span>
          </div>
          <div>
            <h1 className="text-sm sm:text-xl font-black text-[#855D00] font-heading leading-tight">
              {isVi ? 'Kéo kẹo trước' : 'Drag candies first'}
            </h1>
            <p className="text-[11px] text-[#A67C00] font-bold hidden sm:block">
              {isVi ? 'Mở từng cơ chế qua từng màn' : 'Unlock one mechanic at a time'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {economyUnlocked && (
            <div className="flex items-center gap-1.5 bg-[#FFF1CC] px-3 py-1.5 rounded-full border-2 border-[#FF9F1A] shadow-inner text-[#855D00] font-bold">
              <span className="text-sm sm:text-base">🪙</span>
              <span className="font-black text-xs sm:text-sm">{inventory.coins}</span>
            </div>
          )}
          {liveOpsUnlocked && (
            <motion.button
              id="btn-open-spin"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.94 }}
              onClick={() => {
                soundFx.playClick();
                onOpenSpinWheel();
              }}
              title={isVi ? 'Vòng quay' : 'Spin'}
              className="relative w-10 h-10 rounded-2xl bg-white text-slate-800 flex items-center justify-center text-xl shadow-[0_4px_0_#FF9F1A] border-4 border-[#FF9F1A] hover:translate-y-0.5 transition-all"
            >
              🎡
            </motion.button>
          )}
          {economyUnlocked && (
            <motion.button
              id="btn-open-shop"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.94 }}
              onClick={() => {
                soundFx.playClick();
                onOpenShop();
              }}
              title={isVi ? 'Cửa hàng' : 'Shop'}
              className="w-10 h-10 rounded-2xl bg-white text-slate-800 flex items-center justify-center text-xl shadow-[0_4px_0_#FF9F1A] border-4 border-[#FF9F1A] hover:translate-y-0.5 transition-all"
            >
              🏪
            </motion.button>
          )}
          <motion.button
            id="btn-open-settings"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.94 }}
            onClick={() => {
              soundFx.playClick();
              onOpenSettings();
            }}
            title={isVi ? 'Cài đặt' : 'Settings'}
            className="w-10 h-10 rounded-2xl bg-white text-slate-800 flex items-center justify-center text-xl shadow-[0_4px_0_#FF9F1A] border-4 border-[#FF9F1A] hover:translate-y-0.5 transition-all"
          >
            ⚙️
          </motion.button>
        </div>
      </header>
      <section className="academy-welcome" aria-label={isVi ? 'Thứ tự học' : 'Learning order'}>
        <span>{isVi ? 'BƯỚC HIỆN TẠI' : 'CURRENT STEP'}</span>
        <h2>{isVi ? 'Chọn màn sáng nhất.' : 'Pick the glowing level.'}</h2>
        <p>{isVi ? 'Màn đầu chỉ tập kéo và nhìn kẹo snap. Dữ liệu, vật phẩm và ranked mở sau.' : 'First levels teach drag and snap only. Data, items and ranked unlock later.'}</p>
      </section>

      {worldsUnlocked && <MetaOverview language={language} />}

      {worldsUnlocked && (
        <div className="w-full max-w-3xl px-4 mt-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-[#FFF1CC] p-1.5 rounded-3xl border-2 border-[#FF9F1A] shadow-inner">
            {WORLDS.map(world => {
              const isSelected = world.id === selectedWorldId;
              const isUnlocked = inventory.unlockedLevel >= world.levelRange[0];

              return (
                <button
                  key={world.id}
                  id={`btn-world-tab-${world.id}`}
                  onClick={() => {
                    soundFx.playClick();
                    setSelectedWorldId(world.id);
                  }}
                  className={`py-2 px-2 rounded-2xl font-black text-xs sm:text-sm flex items-center justify-center gap-1.5 transition-all ${
                    isSelected
                      ? 'bg-white text-[#855D00] shadow-[0_4px_0_#FF9F1A] border-2 border-[#FF9F1A] scale-102'
                      : 'text-[#855D00]/80 hover:bg-white/60'
                  }`}
                >
                  <span>{world.icon}</span>
                  <span className="truncate">{isVi ? world.nameVi : world.nameEn}</span>
                  {!isUnlocked && <span className="text-xs opacity-60">🔒</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* CURRENT WORLD BANNER */}
      {worldsUnlocked && (
        <motion.div
          key={selectedWorld.id}
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-3xl px-4 mt-4"
        >
          <div
            className={`w-full p-4 rounded-[2rem] bg-gradient-to-r ${selectedWorld.bgGradient} text-white shadow-xl border-4 border-white flex items-center justify-between gap-4`}
          >
            <div>
              <div className="flex items-center gap-2">
                <span className="text-3xl filter drop-shadow">{selectedWorld.icon}</span>
                <h2 className="text-lg sm:text-2xl font-black font-heading drop-shadow-sm">
                  {isVi ? selectedWorld.nameVi : selectedWorld.nameEn}
                </h2>
              </div>
              <p className="text-xs sm:text-sm font-semibold opacity-95 mt-1 max-w-md">
                {isVi ? selectedWorld.descriptionVi : selectedWorld.descriptionEn}
              </p>
            </div>
            <div className="text-right shrink-0 bg-white/25 backdrop-blur-sm px-3 py-1.5 rounded-2xl border border-white/50 shadow-sm">
              <span className="text-[10px] font-black uppercase tracking-wider block">
                {isVi ? 'Màn chơi' : 'Levels'}
              </span>
              <span className="text-base sm:text-lg font-black font-heading">
                {selectedWorld.levelRange[0]} - {selectedWorld.levelRange[1]}
              </span>
            </div>
          </div>
        </motion.div>
      )}

      {/* WINDING LEVEL MAP PATHWAY */}
      <div className="w-full max-w-xl px-4 mt-6 flex flex-col items-center relative">
        {/* Decorative connecting pathway curves */}
        <div className="flex flex-col items-center gap-8 sm:gap-10 w-full py-4 relative">
          {worldLevels.map((lvl, index) => {
            const isUnlocked = inventory.unlockedLevel >= lvl.id;
            const stars = inventory.starsPerLevel[lvl.id] || 0;
            const isCurrent = inventory.unlockedLevel === lvl.id;
            // Zig-zag offset: alternating -30px, 0px, +30px
            const offsets = ['-translate-x-12', 'translate-x-0', 'translate-x-12', 'translate-x-0'];
            const offsetClass = offsets[index % offsets.length];

            return (
              <div key={lvl.id} className={`relative flex flex-col items-center ${offsetClass}`}>
                {/* Level Node Pin */}
                <motion.button
                  id={`btn-level-pin-${lvl.id}`}
                  whileHover={{ scale: isUnlocked ? 1.15 : 1 }}
                  whileTap={{ scale: isUnlocked ? 0.9 : 1 }}
                  onClick={() => {
                    if (isUnlocked) {
                      soundFx.playClick();
                      setPreviewLevel(lvl);
                    }
                  }}
                  className={`w-16 h-16 sm:w-20 sm:h-20 rounded-[1.75rem] relative flex flex-col items-center justify-center transition-all ${
                    isCurrent
                      ? 'bg-[#FFCF4D] border-4 border-white shadow-[0_6px_0_#FF9F1A] ring-4 ring-[#FF9F1A] animate-level-beacon'
                      : isUnlocked
                      ? 'bg-white border-4 border-[#88D66C] shadow-[0_6px_0_#71B15A]'
                      : 'bg-[#EAE5D9] border-4 border-[#D0C9B8] shadow-inner opacity-75 cursor-not-allowed'
                  }`}
                >
                  {isUnlocked ? (
                    <>
                      <span className={`text-xl sm:text-2xl font-black font-heading ${
                        isCurrent ? 'text-[#855D00]' : 'text-[#4A7A37]'
                      }`}>
                        {lvl.id}
                      </span>
                      {/* Boss icon if boss fight */}
                      {lvl.boss && (
                        <span className="absolute -top-3 -right-2 text-base animate-pulse">👑</span>
                      )}
                      {lvl.timeLimit && (
                        <span className="absolute -top-2 -left-2 text-xs bg-[#5EADFF] text-white rounded-full px-1 shadow border border-white">⏱️</span>
                      )}
                    </>
                  ) : (
                    <span className="text-2xl opacity-60">🔒</span>
                  )}
                </motion.button>

                {isUnlocked && stars > 0 && (
                  <div className="flex items-center gap-1 mt-1 bg-white px-2 py-0.5 rounded-full border-2 border-[#FF9F1A] shadow-sm">
                    {[1, 2, 3].map(s => (
                      <span
                        key={s}
                        className={`text-xs ${
                          stars >= s ? 'text-[#FF9F1A]' : 'text-slate-200 grayscale'
                        }`}
                      >
                        ★
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* LEVEL PREVIEW MODAL */}
      {previewLevel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-sm bg-[#FFF9E6] rounded-[2rem] p-6 border-4 border-[#FF9F1A] shadow-[0_8px_0_#E6B800] relative text-center flex flex-col items-center"
          >
            {/* Close Button */}
            <button
              id="btn-close-level-preview"
              onClick={() => setPreviewLevel(null)}
              className="absolute top-3 right-3 w-8 h-8 rounded-full bg-[#FFF1CC] hover:bg-[#FFE6A6] text-[#855D00] font-black text-sm flex items-center justify-center border border-[#FF9F1A]"
            >
              ✕
            </button>

            {/* Title & Level Number */}
            <div className="bg-[#FFCF4D] text-[#855D00] px-4 py-1 rounded-full font-black text-xs uppercase tracking-wider mb-2 border-2 border-[#FF9F1A] shadow-inner">
              {isVi ? `Màn ${previewLevel.id}` : `Level ${previewLevel.id}`}
            </div>
            <h3 className="text-xl font-black text-[#855D00] font-heading">
              {isVi ? previewLevel.nameVi : previewLevel.nameEn}
            </h3>

            {/* Boss Dialogue preview if any */}
            {previewLevel.boss && (
              <div className="my-2 p-2.5 bg-[#FFF1CC] rounded-2xl border-2 border-[#FF9F1A] flex items-center gap-2 text-left w-full">
                <span className="text-2xl">{previewLevel.boss.avatar}</span>
                <div>
                  <span className="font-extrabold text-[#855D00] text-xs block">
                    {isVi ? previewLevel.boss.nameVi : previewLevel.boss.nameEn}
                  </span>
                  <p className="text-[11px] text-[#A67C00] italic">
                    "{isVi ? previewLevel.boss.dialogueVi : previewLevel.boss.dialogueEn}"
                  </p>
                </div>
              </div>
            )}

            {/* Objectives Card */}
            <div className="w-full my-3 p-3 bg-white rounded-2xl border-2 border-[#88D66C] shadow-sm flex flex-col gap-2 text-left">
              <span className="text-[#4A7A37] font-black text-[10px] uppercase tracking-wider">
                {isVi ? 'Mở khóa ở màn này' : 'Unlocked now'}
              </span>
              <div className="flex items-center justify-between text-xs font-bold text-slate-800 bg-[#F0FFF0] p-2 rounded-xl border border-[#88D66C]">
                <span className="flex items-center gap-1.5 text-[#4A7A37]">
                  <span aria-hidden="true">→</span>
                  <span>{isVi ? previewLevel.tipVi : previewLevel.tipEn}</span>
                </span>
              </div>
              <div className="flex items-center justify-between text-xs font-bold text-slate-600 border-t border-[#88D66C]/40 pt-1.5 mt-1">
                <span className="text-[#855D00]">{isVi ? 'Bàn' : 'Board'}</span>
                <span className="font-black text-[#FF7A00]">
                  {previewLevel.rows}×{previewLevel.cols} · {previewLevel.moves}
                </span>
              </div>
            </div>

            {/* Play Button */}
            <div className="grid w-full gap-2">
              <motion.button
                id="btn-start-practice-level"
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => {
                  soundFx.playClick();
                  const lvl = previewLevel;
                  setPreviewLevel(null);
                  onStartPracticeLevel(lvl);
                }}
                className="w-full py-3 bg-[#FF7A00] hover:bg-[#FF8C1A] text-white font-black text-base rounded-2xl border-b-4 border-[#CC6200] shadow-lg flex items-center justify-center gap-2 active:translate-y-1 transition-all"
              >
                <span>{isVi ? 'CHƠI MÀN NÀY' : 'PLAY THIS LEVEL'}</span>
              </motion.button>
              {rankedUnlocked && (
                <motion.button
                  id="btn-start-level-play"
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => {
                    soundFx.playSwap();
                    const lvl = previewLevel;
                    setPreviewLevel(null);
                    onSelectLevel(lvl);
                  }}
                  className="w-full py-3 bg-white hover:bg-[#FFF1CC] text-[#855D00] font-black text-sm rounded-2xl border-2 border-[#FF9F1A] shadow flex items-center justify-center gap-2 active:translate-y-1 transition-all"
                >
                  <span>{isVi ? 'XẾP HẠNG' : 'RANKED'}</span>
                </motion.button>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
};
