import React, { useState } from 'react';
import { motion } from 'motion/react';
import { soundFx } from '../../utils/audio';
import { useAccessibleDialog } from './HowToPlayModal';

interface SettingsModalProps {
  soundEnabled: boolean;
  musicEnabled: boolean;
  language: 'vi' | 'en';
  onToggleSound: () => void;
  onToggleMusic: () => void;
  onToggleLanguage: () => void;
  onResetProgress: () => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  soundEnabled,
  musicEnabled,
  language,
  onToggleSound,
  onToggleMusic,
  onToggleLanguage,
  onResetProgress,
  onClose,
}) => {
  const isVi = language === 'vi';
  const [showConfirmReset, setShowConfirmReset] = useState(false);
  const dialogRef = useAccessibleDialog(onClose, 'btn-close-settings');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        aria-describedby="settings-description"
        tabIndex={-1}
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="w-full max-w-sm bg-[#FFF9E6] rounded-[2rem] p-5 border-4 border-[#FF9F1A] shadow-[0_8px_0_#E6B800] relative flex flex-col text-[#4A3B2C]"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b-2 border-[#FF9F1A]/40">
          <div className="flex items-center gap-2">
            <span className="text-2xl">⚙️</span>
            <h3 id="settings-title" className="text-xl font-black text-[#855D00] font-heading">
              {isVi ? 'Cài Đặt Trò Chơi' : 'Game Settings'}
            </h3>
          </div>
          <button
            id="btn-close-settings"
            aria-label={isVi ? 'Đóng cài đặt' : 'Close settings'}
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-[#FFF1CC] hover:bg-[#FFE6A6] text-[#855D00] font-black text-sm flex items-center justify-center border border-[#FF9F1A]"
          >
            ✕
          </button>
        </div>

        {/* Options */}
        <div id="settings-description" className="flex flex-col gap-3 my-4">
          {/* Sound FX Toggle */}
          <div className="flex items-center justify-between p-3 bg-white rounded-2xl border-2 border-[#FF9F1A]/50 shadow-sm">
            <div className="flex items-center gap-2">
              <span className="text-xl">{soundEnabled ? '🔊' : '🔇'}</span>
              <span className="font-black text-[#855D00] text-sm">
                {isVi ? 'Âm Thanh Hiệu Ứng' : 'Sound Effects (SFX)'}
              </span>
            </div>
            <button
              id="btn-toggle-sound"
              aria-label={isVi ? 'Bật hoặc tắt âm thanh hiệu ứng' : 'Toggle sound effects'}
              aria-pressed={soundEnabled}
              onClick={() => {
                soundFx.playClick();
                onToggleSound();
              }}
              className={`w-14 h-8 flex items-center rounded-full p-1 transition-colors duration-200 border-2 ${
                soundEnabled ? 'bg-[#88D66C] border-[#71B15A]' : 'bg-slate-300 border-slate-400'
              }`}
            >
              <div
                className={`bg-white w-6 h-6 rounded-full shadow-md transform transition-transform duration-200 ${
                  soundEnabled ? 'translate-x-6' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Music Toggle */}
          <div className="flex items-center justify-between p-3 bg-white rounded-2xl border-2 border-[#FF9F1A]/50 shadow-sm">
            <div className="flex items-center gap-2">
              <span className="text-xl">{musicEnabled ? '🎵' : '🎼'}</span>
              <span className="font-black text-[#855D00] text-sm">
                {isVi ? 'Nhạc Nền Dễ Thương' : 'Background Music (BGM)'}
              </span>
            </div>
            <button
              id="btn-toggle-music"
              aria-label={isVi ? 'Bật hoặc tắt nhạc nền' : 'Toggle background music'}
              aria-pressed={musicEnabled}
              onClick={() => {
                soundFx.playClick();
                onToggleMusic();
              }}
              className={`w-14 h-8 flex items-center rounded-full p-1 transition-colors duration-200 border-2 ${
                musicEnabled ? 'bg-[#88D66C] border-[#71B15A]' : 'bg-slate-300 border-slate-400'
              }`}
            >
              <div
                className={`bg-white w-6 h-6 rounded-full shadow-md transform transition-transform duration-200 ${
                  musicEnabled ? 'translate-x-6' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Language Switch */}
          <div className="flex items-center justify-between p-3 bg-white rounded-2xl border-2 border-[#FF9F1A]/50 shadow-sm">
            <div className="flex items-center gap-2">
              <span className="text-xl">🌐</span>
              <span className="font-black text-[#855D00] text-sm">
                {isVi ? 'Ngôn Ngữ / Language' : 'Language / Ngôn Ngữ'}
              </span>
            </div>
            <button
              id="btn-toggle-lang"
              onClick={() => {
                soundFx.playClick();
                onToggleLanguage();
              }}
              className="px-3.5 py-1.5 bg-[#FFF1CC] hover:bg-[#FFE6A6] rounded-xl font-black text-xs text-[#855D00] border-2 border-[#FF9F1A] shadow-[0_2px_0_#FF9F1A] active:scale-95 transition-all"
            >
              {isVi ? '🇻🇳 Tiếng Việt' : '🇬🇧 English'}
            </button>
          </div>
        </div>

        {/* Reset Progress Section */}
        <div className="mt-2 pt-3 border-t border-[#FF9F1A]/40 flex flex-col items-center">
          {showConfirmReset ? (
            <div className="w-full p-3 bg-white border-2 border-[#FF7A00] rounded-2xl text-center flex flex-col gap-2 shadow-sm">
              <p className="text-xs font-black text-[#FF7A00]">
                {isVi ? 'Bạn chắc chắn muốn xoá toàn bộ tiến trình?' : 'Are you sure you want to reset all progress?'}
              </p>
              <div className="flex gap-2">
                <button
                  id="btn-confirm-reset"
                  onClick={() => {
                    onResetProgress();
                    setShowConfirmReset(false);
                    onClose();
                  }}
                  className="flex-1 py-1.5 bg-[#FF7A00] hover:bg-[#FF8C1A] text-white rounded-xl font-black text-xs border-b-2 border-[#CC6200]"
                >
                  {isVi ? 'Đồng Ý Xoá' : 'Yes, Reset'}
                </button>
                <button
                  id="btn-cancel-reset"
                  onClick={() => setShowConfirmReset(false)}
                  className="flex-1 py-1.5 bg-[#FFF1CC] text-[#855D00] rounded-xl font-black text-xs border border-[#FF9F1A]"
                >
                  {isVi ? 'Huỷ' : 'Cancel'}
                </button>
              </div>
            </div>
          ) : (
            <button
              id="btn-trigger-reset"
              onClick={() => setShowConfirmReset(true)}
              className="text-xs font-black text-[#6B4F00] hover:text-[#4A3B2C] underline"
            >
              {isVi ? '🔄 Đặt Lại Tiến Trình Chơi' : '🔄 Reset Game Progress'}
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
};
