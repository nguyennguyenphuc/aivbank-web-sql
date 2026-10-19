import React from 'react';
import { motion } from 'motion/react';
import { CandyColor, CellTile, SpecialType } from '../types/game';

interface TileViewProps {
  tile: CellTile;
  isSelected: boolean;
  isHinted?: boolean;
  onClick: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onTouchStart?: (e: React.TouchEvent) => void;
  onTouchEnd?: (e: React.TouchEvent) => void;
  onTouchMove?: (e: React.TouchEvent) => void;
  dragOffset?: { x: number; y: number } | null;
  isConfirming?: boolean;
  tileSize?: number;
}

export const TileView: React.FC<TileViewProps> = ({
  tile,
  isSelected,
  isHinted,
  onClick,
  onDragStart,
  onDragOver,
  onDrop,
  onTouchStart,
  onTouchMove,
  dragOffset,
  isConfirming,
  onTouchEnd,
}) => {
  const accessible = {
    role: 'button' as const,
    tabIndex: 0,
    'aria-pressed': isSelected,
    'aria-label': `${tile.hasChocolate ? 'Chocolate' : tile.isIngredient ? 'Cherry ingredient' : `${tile.color} candy`}${tile.special !== 'none' ? `, ${tile.special}` : ''}${tile.iceLevel ? `, ice ${tile.iceLevel}` : ''}, row ${tile.row + 1}, column ${tile.col + 1}`,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); }
    },
  };
  // If chocolate block
  if (tile.hasChocolate) {
    return (
      <motion.div
        {...accessible}
        id={`tile-${tile.row}-${tile.col}`}
        data-testid={`practice-tile-${tile.row}-${tile.col}`}
        data-row={tile.row}
        data-col={tile.col}
        data-color={tile.color}
        className="w-full h-full p-1 relative flex items-center justify-center cursor-pointer"
        whileTap={{ scale: 0.95 }}
        onClick={onClick}
      >
        <div className="w-full h-full rounded-2xl bg-amber-900 border-2 border-amber-950 shadow-md relative overflow-hidden flex flex-col items-center justify-center">
          {/* Chocolate wafer squares */}
          <div className="w-3/4 h-3/4 border-2 border-amber-800 rounded-lg bg-amber-950/60 flex items-center justify-center shadow-inner">
            <span className="text-xl select-none">🍫</span>
          </div>
          {/* Dripping glaze */}
          <div className="absolute top-0 left-0 right-0 h-2 bg-amber-800 rounded-b-md opacity-75"></div>
        </div>
      </motion.div>
    );
  }

  // If ingredient (Golden Cherry / Acorn)
  if (tile.isIngredient) {
    return (
      <motion.div
        {...accessible}
        id={`tile-${tile.row}-${tile.col}`}
        data-testid={`practice-tile-${tile.row}-${tile.col}`}
        data-row={tile.row}
        data-col={tile.col}
        data-color={tile.color}
        className="w-full h-full p-1 relative flex items-center justify-center cursor-pointer"
        animate={isHinted ? { scale: [1, 1.15, 1], rotate: [0, -8, 8, 0] } : {}}
        transition={{ repeat: Infinity, duration: 1.2 }}
        onClick={onClick}
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className="w-full h-full rounded-2xl bg-[#FFCF4D] border-2 border-[#FF9F1A] shadow-md flex items-center justify-center relative">
          <span className="text-2xl sm:text-3xl filter drop-shadow-md select-none animate-pulse">🍒</span>
          <span className="absolute -top-1 -right-1 text-xs">✨</span>
        </div>
        {/* Ice overlay */}
        {tile.iceLevel > 0 && <IceOverlay level={tile.iceLevel} />}
      </motion.div>
    );
  }

  return (
    <motion.div
      {...accessible}
      data-special={tile.special}
      id={`tile-${tile.row}-${tile.col}`}
      data-testid={`practice-tile-${tile.row}-${tile.col}`}
      data-row={tile.row}
      data-col={tile.col}
      data-color={tile.color}
      className={`w-full h-full p-0.5 sm:p-1 relative flex items-center justify-center cursor-grab active:cursor-grabbing select-none transition-transform duration-100 ${
        isSelected || dragOffset ? 'z-30' : 'z-10'
      }`}
      layout
      animate={{
        scale: isSelected || dragOffset ? 1.15 : isConfirming ? 1.08 : 1,
        x: dragOffset?.x ?? 0,
        y: dragOffset?.y ?? 0,
      }}
      transition={{ type: 'spring', stiffness: 520, damping: 34, mass: 0.55 }}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.92 }}
      onClick={onClick}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div
        className={`w-full h-full relative flex items-center justify-center rounded-2xl ${
          isSelected ? 'ring-4 ring-[#FF7A00] ring-offset-2 ring-offset-[#FFF9E6] shadow-xl' : ''
        } ${isConfirming ? 'ring-4 ring-[#88D66C] ring-offset-2 ring-offset-[#FFF9E6] shadow-2xl animate-snap-confirm' : ''} ${isHinted ? 'animate-wobble-hint ring-2 ring-white' : ''}`}
      >
        <CandyArt color={tile.color} special={tile.special} />

        {/* Ice Overlay if frozen */}
        {tile.iceLevel > 0 && <IceOverlay level={tile.iceLevel} />}
      </div>
    </motion.div>
  );
};

// Render Ice Layer Overlay
const IceOverlay: React.FC<{ level: number }> = ({ level }) => {
  return (
    <div className={`absolute inset-0 rounded-2xl pointer-events-none flex items-center justify-center border-2 ${
      level === 2
        ? 'bg-cyan-200/75 border-cyan-100 backdrop-blur-[1px] shadow-inner'
        : 'bg-cyan-100/50 border-cyan-200/80 backdrop-blur-[0.5px]'
    }`}>
      {/* Ice crack lines */}
      <svg className="w-full h-full opacity-60 text-white" viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth={level === 2 ? 3 : 2}>
        <path d="M20 20 L50 50 L80 30 M50 50 L40 80 M50 50 L75 75" />
      </svg>
      <span className="absolute bottom-0.5 right-1 text-[10px] font-black text-cyan-800 bg-white/70 rounded-full px-1">
        {level === 2 ? '❄️x2' : '❄️'}
      </span>
    </div>
  );
};

type SharedSpecialType = 'none' | 'striped-h' | 'striped-v' | 'wrapped' | 'rainbow';

interface CandyArtProps {
  color: CandyColor;
  special: SpecialType | SharedSpecialType;
}

// Shared procedural candy art for both local practice and server-ranked play.
export function CandyArt({ color, special }: CandyArtProps) {
  const localSpecial: SpecialType = ({
    'striped-h': 'striped_h',
    'striped-v': 'striped_v',
    wrapped: 'wrapped_bomb',
    rainbow: 'rainbow_candy',
  } as Partial<Record<SharedSpecialType, SpecialType>>)[special as SharedSpecialType] ?? special as SpecialType;

  // Special: Rainbow Star Candy
  if (localSpecial === 'rainbow_candy') {
    return (
      <div className="w-full h-full rounded-2xl bg-gradient-to-tr from-rose-400 via-amber-300 via-emerald-300 to-indigo-400 border-2 border-white shadow-lg flex items-center justify-center relative overflow-hidden animate-pulse-glow">
        <div className="absolute inset-0 bg-[radial-gradient(circle,rgba(255,255,255,0.8)_0%,transparent_70%)]"></div>
        {/* Star Icon with sparkling eyes */}
        <svg className="w-4/5 h-4/5 filter drop-shadow-md" viewBox="0 0 100 100">
          <polygon
            points="50,5 64,36 98,36 70,57 81,91 50,70 19,91 30,57 2,36 36,36"
            fill="#FFFFFF"
            stroke="#FDE047"
            strokeWidth="4"
          />
          <circle cx="40" cy="46" r="4.5" fill="#1E293B" />
          <circle cx="60" cy="46" r="4.5" fill="#1E293B" />
          <circle cx="41.5" cy="44.5" r="1.5" fill="#FFFFFF" />
          <circle cx="61.5" cy="44.5" r="1.5" fill="#FFFFFF" />
          <path d="M 43 56 Q 50 64 57 56" fill="none" stroke="#E11D48" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <span className="absolute -top-1 -right-1 text-xs">✨</span>
      </div>
    );
  }

  // Configuration for each candy color
  const colorConfigs: Record<CandyColor, {
    bg: string;
    border: string;
    shadow: string;
    renderFace: () => React.ReactNode;
  }> = {
    red: {
      bg: 'bg-gradient-to-b from-rose-400 via-red-500 to-rose-600',
      border: 'border-red-300',
      shadow: 'shadow-red-300/60',
      renderFace: () => (
        // Strawberry Heart with happy smile & seeds
        <svg className="w-full h-full p-1" viewBox="0 0 100 100">
          <path
            d="M 50 88 C 20 70 8 45 15 26 C 22 8 42 12 50 24 C 58 12 78 8 85 26 C 92 45 80 70 50 88 Z"
            fill="#F43F5E"
            stroke="#FFE4E6"
            strokeWidth="4"
          />
          {/* Seeds */}
          <circle cx="32" cy="35" r="2" fill="#FFE4E6" />
          <circle cx="68" cy="35" r="2" fill="#FFE4E6" />
          <circle cx="50" cy="45" r="2" fill="#FFE4E6" />
          <circle cx="38" cy="60" r="2" fill="#FFE4E6" />
          <circle cx="62" cy="60" r="2" fill="#FFE4E6" />
          {/* Cute Face */}
          <circle cx="40" cy="48" r="3.5" fill="#4C0519" />
          <circle cx="60" cy="48" r="3.5" fill="#4C0519" />
          <circle cx="41" cy="47" r="1.2" fill="#FFFFFF" />
          <circle cx="61" cy="47" r="1.2" fill="#FFFFFF" />
          <path d="M 43 56 Q 50 62 57 56" fill="none" stroke="#4C0519" strokeWidth="2.5" strokeLinecap="round" />
          {/* Blush */}
          <ellipse cx="33" cy="54" rx="3" ry="1.8" fill="#FB7185" opacity="0.8" />
          <ellipse cx="67" cy="54" rx="3" ry="1.8" fill="#FB7185" opacity="0.8" />
        </svg>
      ),
    },
    orange: {
      bg: 'bg-gradient-to-b from-amber-300 via-orange-500 to-amber-600',
      border: 'border-orange-200',
      shadow: 'shadow-orange-300/60',
      renderFace: () => (
        // Citrus Swirl with cheerful wink
        <svg className="w-full h-full p-1" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="40" fill="#FB923C" stroke="#FFEDD5" strokeWidth="4" />
          <circle cx="50" cy="50" r="30" fill="#F97316" />
          {/* Highlights */}
          <path d="M 25 35 A 30 30 0 0 1 70 24" fill="none" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" opacity="0.6" />
          {/* Eyes: One wink, one open */}
          <path d="M 33 46 Q 39 40 45 46" fill="none" stroke="#7C2D12" strokeWidth="3" strokeLinecap="round" />
          <circle cx="60" cy="46" r="4" fill="#7C2D12" />
          <circle cx="61.5" cy="44.5" r="1.5" fill="#FFFFFF" />
          {/* Smile */}
          <path d="M 43 56 Q 50 65 57 56" fill="#7C2D12" stroke="#7C2D12" strokeWidth="1" />
          {/* Blush */}
          <ellipse cx="31" cy="54" rx="3.5" ry="2" fill="#FCA5A5" />
          <ellipse cx="69" cy="54" rx="3.5" ry="2" fill="#FCA5A5" />
        </svg>
      ),
    },
    yellow: {
      bg: 'bg-gradient-to-b from-yellow-200 via-yellow-400 to-amber-500',
      border: 'border-yellow-100',
      shadow: 'shadow-yellow-300/60',
      renderFace: () => (
        // Star Lemon Drop with cheerful face
        <svg className="w-full h-full p-1" viewBox="0 0 100 100">
          <polygon
            points="50,12 60,38 88,40 66,58 73,86 50,71 27,86 34,58 12,40 40,38"
            fill="#FACC15"
            stroke="#FEF08A"
            strokeWidth="3.5"
          />
          {/* Eyes */}
          <circle cx="41" cy="46" r="3.5" fill="#713F12" />
          <circle cx="59" cy="46" r="3.5" fill="#713F12" />
          <circle cx="42" cy="44.5" r="1.2" fill="#FFFFFF" />
          <circle cx="60" cy="44.5" r="1.2" fill="#FFFFFF" />
          {/* Big open joyful mouth */}
          <path d="M 44 55 Q 50 66 56 55 Z" fill="#DC2626" stroke="#713F12" strokeWidth="1.5" />
          {/* Blush */}
          <ellipse cx="32" cy="53" rx="3.5" ry="2" fill="#F87171" opacity="0.7" />
          <ellipse cx="68" cy="53" rx="3.5" ry="2" fill="#F87171" opacity="0.7" />
        </svg>
      ),
    },
    green: {
      bg: 'bg-gradient-to-b from-emerald-300 via-green-500 to-emerald-600',
      border: 'border-green-200',
      shadow: 'shadow-green-300/60',
      renderFace: () => (
        // Mint Jelly Drop with cute dimples
        <svg className="w-full h-full p-1" viewBox="0 0 100 100">
          <path
            d="M 50 15 C 75 15 88 35 88 60 C 88 78 72 88 50 88 C 28 88 12 78 12 60 C 12 35 25 15 50 15 Z"
            fill="#22C55E"
            stroke="#DCFCE7"
            strokeWidth="3.5"
          />
          {/* Glossy highlight */}
          <ellipse cx="35" cy="30" rx="8" ry="4" fill="#FFFFFF" opacity="0.55" transform="rotate(-30 35 30)" />
          {/* Happy curve eyes */}
          <path d="M 34 50 Q 40 43 46 50" fill="none" stroke="#052E16" strokeWidth="3" strokeLinecap="round" />
          <path d="M 54 50 Q 60 43 66 50" fill="none" stroke="#052E16" strokeWidth="3" strokeLinecap="round" />
          {/* Tongue smile */}
          <path d="M 44 58 Q 50 66 56 58" fill="none" stroke="#052E16" strokeWidth="2.5" strokeLinecap="round" />
          <ellipse cx="30" cy="56" rx="3" ry="1.8" fill="#F472B6" opacity="0.8" />
          <ellipse cx="70" cy="56" rx="3" ry="1.8" fill="#F472B6" opacity="0.8" />
        </svg>
      ),
    },
    blue: {
      bg: 'bg-gradient-to-b from-sky-300 via-blue-500 to-indigo-600',
      border: 'border-blue-200',
      shadow: 'shadow-blue-300/60',
      renderFace: () => (
        // Blueberry Bubble with anime starry eyes
        <svg className="w-full h-full p-1" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="38" fill="#3B82F6" stroke="#DBEAFE" strokeWidth="3.5" />
          {/* Gloss */}
          <ellipse cx="35" cy="30" rx="7" ry="3.5" fill="#FFFFFF" opacity="0.6" transform="rotate(-30 35 30)" />
          {/* Big anime eyes */}
          <ellipse cx="38" cy="48" rx="5" ry="6" fill="#1E1B4B" />
          <ellipse cx="62" cy="48" rx="5" ry="6" fill="#1E1B4B" />
          <circle cx="36" cy="46" r="2.2" fill="#FFFFFF" />
          <circle cx="60" cy="46" r="2.2" fill="#FFFFFF" />
          <circle cx="39" cy="50" r="1" fill="#FFFFFF" />
          <circle cx="63" cy="50" r="1" fill="#FFFFFF" />
          {/* Sweet smile */}
          <path d="M 44 58 Q 50 63 56 58" fill="none" stroke="#1E1B4B" strokeWidth="2.5" strokeLinecap="round" />
          <ellipse cx="30" cy="56" rx="3" ry="1.8" fill="#F43F5E" opacity="0.6" />
          <ellipse cx="70" cy="56" rx="3" ry="1.8" fill="#F43F5E" opacity="0.6" />
        </svg>
      ),
    },
    purple: {
      bg: 'bg-gradient-to-b from-purple-300 via-purple-500 to-fuchsia-700',
      border: 'border-purple-200',
      shadow: 'shadow-purple-300/60',
      renderFace: () => (
        // Royal Grape Gumdrop with crown & sparkle
        <svg className="w-full h-full p-1" viewBox="0 0 100 100">
          <path
            d="M 50 18 L 82 45 L 70 82 L 30 82 L 18 45 Z"
            fill="#A855F7"
            stroke="#F3E8FF"
            strokeWidth="3.5"
          />
          {/* Little Golden Crown */}
          <polygon points="40,24 45,30 50,22 55,30 60,24 58,34 42,34" fill="#FACC15" stroke="#FEF08A" strokeWidth="1" />
          {/* Eyes */}
          <circle cx="38" cy="50" r="3.5" fill="#3B0764" />
          <circle cx="62" cy="50" r="3.5" fill="#3B0764" />
          <circle cx="39" cy="48.5" r="1.2" fill="#FFFFFF" />
          <circle cx="63" cy="48.5" r="1.2" fill="#FFFFFF" />
          {/* Smile */}
          <path d="M 44 59 Q 50 65 56 59" fill="none" stroke="#3B0764" strokeWidth="2.5" strokeLinecap="round" />
          <ellipse cx="30" cy="57" rx="3" ry="1.8" fill="#F472B6" opacity="0.7" />
          <ellipse cx="70" cy="57" rx="3" ry="1.8" fill="#F472B6" opacity="0.7" />
        </svg>
      ),
    },
  };

  const config = colorConfigs[color] || colorConfigs.red;

  return (
    <div className={`w-full h-full rounded-2xl ${config.bg} border-2 ${config.border} shadow-md ${config.shadow} relative overflow-hidden flex items-center justify-center`}>
      {config.renderFace()}

      {/* SPECIAL OVERLAYS */}
      {/* 1. Striped Horizontal Rocket */}
      {localSpecial === 'striped_h' && (
        <div className="absolute inset-0 pointer-events-none flex flex-col justify-around py-1">
          <div className="w-full h-1.5 bg-white/90 shadow-[0_0_8px_#ffffff] rounded-full"></div>
          <div className="w-full h-1.5 bg-white/90 shadow-[0_0_8px_#ffffff] rounded-full"></div>
          <div className="w-full h-1.5 bg-white/90 shadow-[0_0_8px_#ffffff] rounded-full"></div>
          <span className="absolute top-0.5 right-0.5 text-[10px]">🚀↔️</span>
        </div>
      )}

      {/* 2. Striped Vertical Rocket */}
      {localSpecial === 'striped_v' && (
        <div className="absolute inset-0 pointer-events-none flex justify-around px-1">
          <div className="h-full w-1.5 bg-white/90 shadow-[0_0_8px_#ffffff] rounded-full"></div>
          <div className="h-full w-1.5 bg-white/90 shadow-[0_0_8px_#ffffff] rounded-full"></div>
          <div className="h-full w-1.5 bg-white/90 shadow-[0_0_8px_#ffffff] rounded-full"></div>
          <span className="absolute top-0.5 right-0.5 text-[10px]">🚀↕️</span>
        </div>
      )}

      {/* 3. Wrapped Bomb */}
      {localSpecial === 'wrapped_bomb' && (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center ring-2 ring-yellow-300/80 rounded-2xl bg-amber-400/20">
          <div className="absolute -top-1.5 -left-1.5 text-xs animate-bounce">🎀</div>
          <div className="absolute -top-1.5 -right-1.5 text-xs animate-bounce">🎀</div>
          <div className="absolute -bottom-1 -right-1 text-xs">💣</div>
        </div>
      )}
    </div>
  );
}
