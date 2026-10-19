import React, { useEffect, useRef } from 'react';
import { motion } from 'motion/react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useAccessibleDialog(onDismiss: () => void, initialFocusId: string, enabled = true) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!enabled) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initial = dialog.querySelector<HTMLElement>(`#${initialFocusId}`)
      ?? dialog.querySelector<HTMLElement>(FOCUSABLE);
    const topDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
      .filter(element => element.getClientRects().length > 0).at(-1);
    if (topDialog === dialog) initial?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].filter(element => element.getClientRects().length > 0);
      if (dialogs.at(-1) !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter(element => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const remainingDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
        .filter(element => element !== dialog && element.getClientRects().length > 0).at(-1);
      if (remainingDialog) {
        if (remainingDialog.contains(document.activeElement)) return;
        const target = previousFocus && remainingDialog.contains(previousFocus)
          ? previousFocus : remainingDialog.querySelector<HTMLElement>(FOCUSABLE);
        target?.focus();
      } else if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [initialFocusId, enabled]);

  return dialogRef;
}

interface HowToPlayModalProps {
  onClose: () => void;
  language: 'vi' | 'en';
}

export const HowToPlayModal: React.FC<HowToPlayModalProps> = ({ onClose, language }) => {
  const isVi = language === 'vi';
  const dialogRef = useAccessibleDialog(onClose, 'btn-close-howtoplay');

  const guideSections = [
    {
      icon: '🍓🍋🫐',
      titleVi: 'Ghép 3 Kẹo Cơ Bản',
      titleEn: 'Basic Match 3',
      descVi: 'Vuốt hoặc chạm 2 viên kẹo liền kề để tạo thành hàng 3 viên cùng màu thẳng hàng và ghi điểm!',
      descEn: 'Swipe or tap 2 adjacent candies to line up 3 of the same color to score!',
    },
    {
      icon: '🚀✨',
      titleVi: 'Kẹo Tên Lửa Sọc (Ghép 4)',
      titleEn: 'Striped Rocket (Match 4)',
      descVi: 'Ghép 4 viên thẳng hàng tạo Kẹo Sọc. Khi phát nổ sẽ bắn tan nát toàn bộ hàng hoặc cột!',
      descEn: 'Match 4 in a line to create a Rocket that wipes entire rows or columns!',
    },
    {
      icon: '💣🎀',
      titleVi: 'Kẹo Bom Nổ (Ghép 5 hình L hoặc T)',
      titleEn: 'Wrapped Bomb (Match 5 in L/T)',
      descVi: 'Ghép 5 viên theo hình chữ T hoặc L để tạo Kẹo Bom nổ tung diện rộng 3x3!',
      descEn: 'Match 5 in L or T intersection to craft an explosive 3x3 blast bomb!',
    },
    {
      icon: '⭐🌈',
      titleVi: 'Ngôi Sao Cầu Vồng (Ghép 5 Thẳng Hàng)',
      titleEn: 'Rainbow Star (Match 5 in Line)',
      descVi: 'Ghép 5 viên thẳng hàng tạo Ngôi Sao Cầu Vồng. Đổi chỗ với bất kỳ kẹo nào để hút sạch màu đó!',
      descEn: 'Match 5 straight in a row for Rainbow Star! Swap with any color to sweep all of them!',
    },
    {
      icon: '💥🌟',
      titleVi: 'Siêu Kết Hợp (Combo Specials)',
      titleEn: 'Super Special Combos',
      descVi: 'Ghép 2 viên kẹo đặc biệt cạnh nhau (Tên Lửa + Bom, Cầu Vồng + Tên Lửa, Cầu Vồng + Cầu Vồng) để tạo siêu bão nổ!',
      descEn: 'Swap two specials together (Rocket + Bomb, Rainbow + Rocket, Rainbow + Rainbow) for epic board wipes!',
    },
    {
      icon: '❄️🍫🍒',
      titleVi: 'Các Chướng Ngại & Mục Tiêu',
      titleEn: 'Obstacles & Goals',
      descVi: 'Phá Băng Tuyết, ngăn Sô-cô-la lan rộng, dẫn Cherry Vàng xuống đáy, và đánh bại Vua Kẹo Dẻo!',
      descEn: 'Melt ice layers, eliminate chocolate slime, drop fruits to bottom, and defeat Bosses!',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="howtoplay-title"
        aria-describedby="howtoplay-description"
        tabIndex={-1}
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="w-full max-w-lg bg-[#FFF9E6] rounded-[2rem] p-5 border-4 border-[#FF9F1A] shadow-[0_8px_0_#E6B800] relative flex flex-col max-h-[90vh] overflow-y-auto text-[#4A3B2C]"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b-2 border-[#FF9F1A]/40">
          <div className="flex items-center gap-2">
            <span className="text-2xl">📖</span>
            <h3 id="howtoplay-title" className="text-xl font-black text-[#855D00] font-heading">
              {isVi ? 'Bí Kíp Chơi Match-3' : 'How To Play'}
            </h3>
          </div>
          <button
            id="btn-close-howtoplay"
            aria-label={isVi ? 'Đóng hướng dẫn' : 'Close instructions'}
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-[#FFF1CC] hover:bg-[#FFE6A6] text-[#855D00] font-black text-sm flex items-center justify-center border border-[#FF9F1A]"
          >
            ✕
          </button>
        </div>

        {/* Sections */}
        <div id="howtoplay-description" className="grid grid-cols-1 gap-3 my-3">
          {guideSections.map((item, idx) => (
            <div
              key={idx}
              className="p-3 bg-white rounded-2xl border-2 border-[#88D66C] shadow-sm flex items-start gap-3"
            >
              <div className="w-11 h-11 shrink-0 rounded-xl bg-[#F0FFF0] border border-[#88D66C] flex items-center justify-center text-xl shadow-inner">
                {item.icon}
              </div>
              <div>
                <h4 className="font-black text-[#4A7A37] text-sm">
                  {isVi ? item.titleVi : item.titleEn}
                </h4>
                <p className="text-slate-700 text-xs mt-0.5 leading-relaxed font-semibold">
                  {isVi ? item.descVi : item.descEn}
                </p>
              </div>
            </div>
          ))}
        </div>

        <button
          id="btn-howtoplay-understand"
          onClick={onClose}
          className="w-full py-3 mt-2 bg-[#FF7A00] hover:bg-[#FF8C1A] text-white font-black text-sm rounded-2xl border-b-4 border-[#CC6200] shadow-lg active:translate-y-1 transition-all"
        >
          {isVi ? 'Đã Hiểu, Chiến Thôi!' : 'Got It, Let’s Play!'}
        </button>
      </motion.div>
    </div>
  );
};
