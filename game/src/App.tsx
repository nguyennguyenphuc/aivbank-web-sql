import { useState, useEffect, useCallback, useRef, lazy } from 'react';
import { MotionConfig } from 'motion/react';
import { BoosterType, LevelConfig, Objective, PlayerInventory } from './types/game';
import { LEVELS } from './data/levels';
import { VictoryModal } from './components/modals/VictoryModal';
import { DefeatModal } from './components/modals/DefeatModal';
import { SpinWheelModal } from './components/modals/SpinWheelModal';
import { ShopModal } from './components/modals/ShopModal';
import { HowToPlayModal } from './components/modals/HowToPlayModal';
import { SettingsModal } from './components/modals/SettingsModal';
import { soundFx } from './utils/audio';
import { AuthProvider, EMBEDDED_IN_AIVB, useAuth } from './features/auth/auth-context';
import { AuthScreen } from './features/auth/auth-screen';
import { apiFetch } from './features/auth/api-client';
import { GameLearningLayout } from './features/analytics/game-learning-layout';
import type { RemoteConfigRevision } from '../shared/contracts/experiments';
import type { WalletSnapshot, DailyGiftStatus, DailyGiftClaimResult } from '../shared/contracts/economy';
import type { RewardGrant } from '../shared/contracts/economy';
import type { PlayerSnapshot } from '../shared/contracts/player';
import { GameObservationProvider, useObservationStudio } from './features/analytics/game-observation-context';
import { GlobalEventLog } from './features/analytics/global-event-log';
import { RouteBoundary } from './components/route-boundary';
import type { GameObservation } from './features/analytics/game-observations';
const ClassroomHub = lazy(() => import('./features/classroom/classroom-hub').then(module => ({ default: module.ClassroomHub })));
const TeachingLab = lazy(() => import('./features/analytics/teaching-lab').then(module => ({ default: module.TeachingLab })));
const AdminOps = lazy(() => import('./features/admin/admin-ops').then(module => ({ default: module.AdminOps })));
const WorldMap = lazy(() => import('./components/WorldMap').then(module => ({ default: module.WorldMap })));
const GameScreen = lazy(() => import('./components/GameScreen').then(module => ({ default: module.GameScreen })));
const RankedGameScreen = lazy(() => import('./features/gameplay/ranked-game-screen').then(module => ({ default: module.RankedGameScreen })));

const STORAGE_KEY = 'sweet_candy_match3_save_v1';

const DEFAULT_INVENTORY: PlayerInventory = {
  coins: 250,
  boosters: {
    hammer: 3,
    shuffle: 3,
    lightning: 2,
    extraMoves: 2,
  },
  starsPerLevel: {},
  highScores: {},
  unlockedLevel: 1,
  soundEnabled: true,
  musicEnabled: true,
  language: 'vi',
};

function PlayerGame() {
  const { principal } = useAuth();
  const { record, setLanguage, setOpen: setLogOpen } = useObservationStudio();
  // Load or initialize inventory
  const [inventory, setInventory] = useState<PlayerInventory>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return { ...DEFAULT_INVENTORY, ...JSON.parse(saved) };
      }
    } catch {
      // ignore
    }
    return DEFAULT_INVENTORY;
  });

  // Navigation State
  const [activeLevel, setActiveLevel] = useState<LevelConfig | null>(null);
  const [offlinePractice, setOfflinePractice] = useState(false);
  const [practiceMoveBonus, setPracticeMoveBonus] = useState(0);

  const openLevel = useCallback((level: LevelConfig, practice: boolean) => {
    setVictoryData(null);
    setDefeatData(null);
    setOfflinePractice(practice);
    setPracticeMoveBonus(0);
    setActiveLevel(level);
  }, []);

  const walletVersion = useRef<{ accountId: string; revision: number } | null>(null);
  const applyWallet = useCallback((wallet: WalletSnapshot) => {
    if (walletVersion.current?.accountId === wallet.accountId && walletVersion.current.revision > wallet.revision) return;
    walletVersion.current = { accountId: wallet.accountId, revision: wallet.revision };
    setInventory(previous => ({
      ...previous,
      coins: wallet.soft,
      boosters: {
        hammer: wallet.inventory.hammer ?? 0,
        shuffle: wallet.inventory.shuffle ?? 0,
        lightning: wallet.inventory.lightning ?? 0,
        extraMoves: wallet.inventory.extraMoves ?? 0,
      },
    }));
  }, []);

  const refreshCloudState = useCallback(async () => {
    await apiFetch<WalletSnapshot>('/api/v1/economy/bootstrap', { method: 'POST' });
    const [wallet, snapshot] = await Promise.all([
      apiFetch<WalletSnapshot>('/api/v1/economy/wallet'),
      apiFetch<PlayerSnapshot>('/api/v1/player/snapshot'),
    ]);
    applyWallet(wallet);
    setInventory(previous => ({
      ...previous,
      unlockedLevel: Math.max(previous.unlockedLevel, snapshot.progress.unlockedLevel),
      soundEnabled: snapshot.settings.sound,
      musicEnabled: snapshot.settings.music,
      language: snapshot.settings.locale.startsWith('en') ? 'en' : previous.language,
    }));
  }, [applyWallet]);

  useEffect(() => { if (principal) void refreshCloudState(); }, [principal, refreshCloudState]);

  // Modals
  const [victoryData, setVictoryData] = useState<{
    levelId: number;
    score: number;
    stars: number;
    coinsEarned: number;
    isNewRecord: boolean;
  } | null>(null);

  const [defeatData, setDefeatData] = useState<{
    levelId: number;
    objectives: Objective[];
  } | null>(null);

  const [showSpinWheel, setShowSpinWheel] = useState(false);
  const [showShop, setShowShop] = useState(false);
  const [showHowToPlay, setShowHowToPlay] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const visibleDialog: Extract<GameObservation, { type: 'dialog_opened' }>['dialog'] | null = showShop ? 'shop' : showSettings ? 'settings' : showHowToPlay ? 'guide' : showSpinWheel ? 'spin' : victoryData ? 'victory' : defeatData ? 'defeat' : null;
  const lastDialog = useRef<typeof visibleDialog>(null);
  useEffect(() => {
    record({ type: 'screen_viewed', screen: activeLevel ? (offlinePractice ? 'practice' : 'ranked') : 'map' });
  }, [activeLevel, offlinePractice, record]);
  useEffect(() => { setLanguage(inventory.language); }, [inventory.language, setLanguage]);
  useEffect(() => {
    if (visibleDialog && visibleDialog !== lastDialog.current) record({ type: 'dialog_opened', dialog: visibleDialog });
    lastDialog.current = visibleDialog;
  }, [visibleDialog, record]);

  // Persist inventory to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(inventory));
    } catch {
      // ignore
    }
  }, [inventory]);

  // Sync sound settings with AudioManager
  useEffect(() => {
    soundFx.setSoundMuted(!inventory.soundEnabled);
    soundFx.setMusicMuted(!inventory.musicEnabled);
    if (inventory.musicEnabled) {
      soundFx.startBGM();
    } else {
      soundFx.stopBGM();
    }
  }, [inventory.soundEnabled, inventory.musicEnabled]);

  // Handle Win Level
  const handleWinLevel = useCallback((finalScore: number, stars: number) => {
    if (!activeLevel) return;

    const levelId = activeLevel.id;
    const currentHigh = inventory.highScores[levelId] || 0;
    const isNewRecord = finalScore > currentHigh;
    const previousStars = inventory.starsPerLevel[levelId] || 0;
    const isFirstTimeWin = previousStars === 0;

    // Coins reward: base 50 + 25 per star + first-time bonus
    const coinsEarned = 50 + stars * 25 + (isFirstTimeWin ? 50 : 0);
    const nextLevelId = levelId + 1;
    const newUnlocked = Math.max(inventory.unlockedLevel, nextLevelId);

    setInventory(prev => ({
      ...prev,
      coins: prev.coins + coinsEarned,
      unlockedLevel: Math.min(LEVELS.length, newUnlocked),
      starsPerLevel: {
        ...prev.starsPerLevel,
        [levelId]: Math.max(previousStars, stars),
      },
      highScores: {
        ...prev.highScores,
        [levelId]: Math.max(currentHigh, finalScore),
      },
    }));

    setVictoryData({
      levelId,
      score: finalScore,
      stars,
      coinsEarned,
      isNewRecord,
    });
    window.setTimeout(() => void refreshCloudState(), 300);
  }, [activeLevel, inventory.highScores, inventory.starsPerLevel, inventory.unlockedLevel, refreshCloudState]);

  // Handle Lose Level
  const handleLoseLevel = useCallback((remainingObjectives: Objective[]) => {
    if (!activeLevel) return;
    setDefeatData({
      levelId: activeLevel.id,
      objectives: remainingObjectives,
    });
  }, [activeLevel]);

  const handleConsumeBooster = useCallback(async (type: BoosterType, referenceId: string): Promise<void> => {
    const wallet = await apiFetch<WalletSnapshot>('/api/v1/economy/use-booster', {
      method: 'POST',
      headers: { 'idempotency-key': `booster:${referenceId}:${type}` },
      body: JSON.stringify({ boosterType: type, referenceId }),
    });
    applyWallet(wallet);
  }, [applyWallet]);

  // Buy a booster in shop
  const handleBuyBooster = async (type: BoosterType, _cost: number, _count: number, intentKey: string) => {
    const products: Record<BoosterType, string> = {
      hammer: 'hammer-2', lightning: 'lightning-2', shuffle: 'shuffle-3', extraMoves: 'extra-moves-2',
    };
    const wallet = await apiFetch<WalletSnapshot>('/api/v1/commerce/buy', {
      method: 'POST',
      headers: { 'idempotency-key': `shop:${type}:${intentKey}` },
      body: JSON.stringify({ productId: products[type] }),
    });
    applyWallet(wallet);
  };

  // Claim free coins gift
  const handleLoadDailyGift = useCallback(async (): Promise<DailyGiftStatus> => {
    const status = await apiFetch<DailyGiftStatus>('/api/v1/economy/daily-gift');
    const wallet = await apiFetch<WalletSnapshot>('/api/v1/economy/wallet');
    applyWallet(wallet);
    return status;
  }, [applyWallet]);

  const handleClaimFreeCoins = async (day: string): Promise<DailyGiftClaimResult> => {
    const result = await apiFetch<DailyGiftClaimResult>('/api/v1/economy/daily-gift', {
      method: 'POST', headers: { 'idempotency-key': `daily-gift:${day}` }, body: JSON.stringify({ day }),
    });
    applyWallet(result.wallet);
    return result;
  };

  const handleDailySpin = async (): Promise<{ coins: number; booster?: BoosterType; boosterCount?: number }> => {
    const day = new Date().toISOString().slice(0, 10);
    const result = await apiFetch<{ reward: RewardGrant[]; wallet: WalletSnapshot }>('/api/v1/economy/daily-spin', {
      method: 'POST', headers: { 'idempotency-key': `daily-spin:${day}` }, body: JSON.stringify({ day }),
    });
    applyWallet(result.wallet);
    setInventory(previous => ({ ...previous, lastDailySpinDate: day }));
    const grant = result.reward[0] ?? {};
    return {
      coins: grant.currency === 'soft' ? grant.amount ?? 0 : 0,
      booster: grant.itemId as BoosterType | undefined,
      boosterCount: grant.quantity,
    };
  };

  const handleClaimSpinReward = () => undefined;

  // Restart active level
  const handleReplay = (bonusMoves = 0) => {
    if (!activeLevel) return;
    const current = activeLevel;
    setVictoryData(null);
    setDefeatData(null);
    setActiveLevel(null);
    setTimeout(() => {
      setPracticeMoveBonus(bonusMoves);
      setActiveLevel(current);
    }, 50);
  };

  // Next Level
  const handleNextLevel = () => {
    if (!activeLevel) return;
    const nextLvl = LEVELS.find(l => l.id === activeLevel.id + 1);
    setVictoryData(null);
    setDefeatData(null);
    setPracticeMoveBonus(0);
    if (nextLvl) {
      setActiveLevel(nextLvl);
    } else {
      setActiveLevel(null);
    }
  };

  const inspectAttempt = () => {
    setVictoryData(null);
    setDefeatData(null);
    setLogOpen(true);
  };

  return (
    <div className="w-full min-h-screen font-sans bg-[#FFF9E6] text-[#4A3B2C] antialiased select-none">
      {/* MAIN VIEW */}
      {activeLevel ? (
        <GameLearningLayout
          key={`${activeLevel.id}-${offlinePractice ? 'practice' : 'ranked'}`}
          levelId={activeLevel.id}
          mode={offlinePractice ? 'practice' : 'ranked'}
          language={inventory.language}
          onReplay={() => handleReplay()}
          onInspect={inspectAttempt}
        >
        {!offlinePractice ? (
        <RankedGameScreen
          level={activeLevel}
          language={inventory.language}
          onWin={handleWinLevel}
          onLose={() => handleLoseLevel(activeLevel.objectives.map(objective => ({ ...objective, current: 0 })))}
          onBack={() => setActiveLevel(null)}
          onOfflineFallback={() => setOfflinePractice(true)}
        />
      ) : (
        <GameScreen
          key={`level-${activeLevel.id}`}
          level={activeLevel}
          inventory={inventory}
          onWinLevel={handleWinLevel}
          onLoseLevel={handleLoseLevel}
          onBackToMap={() => {
            setActiveLevel(null);
            setOfflinePractice(false);
            setPracticeMoveBonus(0);
            setVictoryData(null);
            setDefeatData(null);
          }}
          onConsumeBooster={handleConsumeBooster}
          onOpenShop={() => setShowShop(true)}
          language={inventory.language}
          initialExtraMoves={practiceMoveBonus}
        />
      )}
        </GameLearningLayout>
      ) : (
        <WorldMap
          inventory={inventory}
          onSelectLevel={lvl => openLevel(lvl, false)}
          onStartPracticeLevel={lvl => openLevel(lvl, true)}
          onOpenSpinWheel={() => setShowSpinWheel(true)}
          onOpenShop={() => setShowShop(true)}
          onOpenHowToPlay={() => setShowHowToPlay(true)}
          onOpenSettings={() => setShowSettings(true)}
          language={inventory.language}
        />
      )}


      {/* VICTORY MODAL */}
      {victoryData && (
        <VictoryModal
          levelId={victoryData.levelId}
          score={victoryData.score}
          stars={victoryData.stars}
          coinsEarned={victoryData.coinsEarned}
          isNewRecord={victoryData.isNewRecord}
          hasNextLevel={Boolean(LEVELS.find(l => l.id === victoryData.levelId + 1))}
          onNextLevel={handleNextLevel}
          onReplay={() => handleReplay()}
          onInspect={inspectAttempt}
          onBackToMap={() => {
            setVictoryData(null);
            setActiveLevel(null);
            setPracticeMoveBonus(0);
          }}
          language={inventory.language}
        />
      )}

      {/* DEFEAT MODAL */}
      {defeatData && (
        <DefeatModal
          levelId={defeatData.levelId}
          objectives={defeatData.objectives}
          hasExtraMovesBooster={offlinePractice && (inventory.boosters.extraMoves || 0) > 0}
          canBuyExtraMoves={offlinePractice}
          playerCoins={inventory.coins}
          onUseExtraMoves={async intentKey => {
            const referenceId = `defeat-extra-moves:${activeLevel?.id ?? 'unknown'}:${intentKey}`;
            await handleConsumeBooster('extraMoves', referenceId);
            setDefeatData(null);
            handleReplay(5);
          }}
          onBuyExtraMoves={async intentKey => {
            if (!offlinePractice) throw new Error('Extra moves are available in practice mode only');
            const attemptId = `practice-defeat:${activeLevel?.id ?? 'unknown'}:${intentKey}`;
            const wallet = await apiFetch<WalletSnapshot>('/api/v1/economy/extra-moves', {
              method: 'POST',
              headers: { 'idempotency-key': `extra-moves:${attemptId}` },
              body: JSON.stringify({ attemptId }),
            });
            applyWallet(wallet);
            setDefeatData(null);
            handleReplay(5);
          }}
          onRetry={() => handleReplay()}
          onInspect={inspectAttempt}
          onBackToMap={() => {
            setDefeatData(null);
            setActiveLevel(null);
          }}
          language={inventory.language}
        />
      )}

      {/* LUCKY SPIN WHEEL */}
      {showSpinWheel && (
        <SpinWheelModal
          canFreeSpin={inventory.lastDailySpinDate !== new Date().toISOString().slice(0, 10)}
          onSpin={handleDailySpin}
          onClaimReward={handleClaimSpinReward}
          onClose={() => setShowSpinWheel(false)}
          language={inventory.language}
        />
      )}

      {/* CANDY EMPORIUM SHOP */}
      {showShop && (
        <ShopModal
          inventory={inventory}
          onBuyBooster={handleBuyBooster}
          onClaimFreeCoins={handleClaimFreeCoins}
          onLoadDailyGift={handleLoadDailyGift}
          onClose={() => setShowShop(false)}
          language={inventory.language}
        />
      )}

      {/* HOW TO PLAY GUIDE */}
      {showHowToPlay && (
        <HowToPlayModal
          onClose={() => setShowHowToPlay(false)}
          language={inventory.language}
        />
      )}

      {/* SETTINGS */}
      {showSettings && (
        <SettingsModal
          soundEnabled={inventory.soundEnabled}
          musicEnabled={inventory.musicEnabled}
          language={inventory.language}
          onToggleSound={() =>
            setInventory(prev => ({ ...prev, soundEnabled: !prev.soundEnabled }))
          }
          onToggleMusic={() =>
            setInventory(prev => ({ ...prev, musicEnabled: !prev.musicEnabled }))
          }
          onToggleLanguage={() =>
            setInventory(prev => ({ ...prev, language: prev.language === 'vi' ? 'en' : 'vi' }))
          }
          onResetProgress={() => {
            localStorage.removeItem(STORAGE_KEY);
            setInventory(DEFAULT_INVENTORY);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

type AppRoute = 'player' | 'classroom' | 'analyst' | 'admin';

function currentRoute(): AppRoute {
  const route = window.location.hash.replace(/^#\/?/, '');
  return ['classroom', 'analyst', 'admin'].includes(route) ? route as AppRoute : 'player';
}

function AuthenticatedApp() {
  const { record } = useObservationStudio();
  const { principal, ready, logout } = useAuth();
  const [route, setRoute] = useState<AppRoute>(currentRoute);
  const [clientBlocked, setClientBlocked] = useState(false);
  useEffect(() => {
    const listener = () => setRoute(currentRoute());
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, []);
  useEffect(() => {
    if (!principal) return;
    apiFetch<{ compatible: boolean; config?: RemoteConfigRevision }>('/api/v1/experiments/remote-config?appVersion=0.1.0')
      .then(result => setClientBlocked(!result.compatible || Boolean(result.config?.values.blockedClientRevisions?.includes('0.1.0'))))
      .catch(() => undefined);
  }, [principal]);
  useEffect(() => {
    if (!ready) return;
    if (!principal) { record({ type: 'screen_viewed', screen: 'login' }); return; }
    if (clientBlocked) { record({ type: 'screen_viewed', screen: 'maintenance' }); return; }
    if (route === 'player') return;
    const authorized = route === 'classroom' || (route === 'admin' ? principal.roles.includes('admin') : principal.roles.some(role => ['instructor', 'analyst', 'admin'].includes(role)));
    record({ type: 'screen_viewed', screen: authorized ? route : 'access_denied' });
  }, [ready, principal, clientBlocked, route, record]);
  if (!ready) return <main className="min-h-screen bg-[#FFF9E6] flex items-center justify-center font-black text-[#855D00]">🍬 Đang khởi động Học viện…</main>;
  if (!principal) return <AuthScreen />;
  if (clientBlocked) return <main className="min-h-screen bg-[#FFF9E6] p-6 flex items-center justify-center"><section className="max-w-md rounded-3xl bg-white p-8 text-center shadow-xl"><div className="text-5xl">🧰</div><h1 className="mt-3 text-xl font-black">Phiên bản đang được bảo trì</h1><p className="mt-2 font-bold text-slate-600">Hãy tải lại sau khi bản H5 an toàn được phát hành.</p></section></main>;
  const canAnalyze = principal.roles.some(role => ['instructor', 'analyst', 'admin'].includes(role));
  const isAdmin = principal.roles.includes('admin');
  return (
    <div className="min-h-screen bg-[#FFF9E6] pb-20">
      <RouteBoundary key={route}>
      {route === 'player' && <PlayerGame key={principal.accountId} />}
      {route === 'classroom' && <ClassroomHub principal={principal} />}
      {route === 'analyst' && (canAnalyze ? <TeachingLab /> : <AccessDenied />)}
      {route === 'admin' && (isAdmin ? <AdminOps /> : <AccessDenied />)}
      </RouteBoundary>
      <nav aria-label="Điều hướng chính" className="app-navigation fixed bottom-0 left-1/2 z-50 flex w-[min(96vw,700px)] -translate-x-1/2 items-center justify-around gap-1 rounded-t-3xl border-2 border-b-0 border-[#FFCF4D] bg-white/95 p-2 shadow-2xl backdrop-blur">
        <NavLink route="player" current={route} icon="🍭" label="Chơi" />
        <NavLink route="classroom" current={route} icon="🎓" label="Lớp học" />
        {canAnalyze && <NavLink route="analyst" current={route} icon="📊" label="Phân tích" />}
        {isAdmin && <NavLink route="admin" current={route} icon="🛠️" label="Quản trị" />}
        {/* Trong AIV Bank, đăng xuất do ứng dụng chủ quyết định. */}
        {!EMBEDDED_IN_AIVB && <button onClick={() => void logout()} className="rounded-xl px-2 py-2 text-[10px] font-black text-slate-500" aria-label="Đăng xuất">↪️<span className="block">Thoát</span></button>}
      </nav>
    </div>
  );
}

function NavLink({ route, current, icon, label }: { route: AppRoute; current: AppRoute; icon: string; label: string }) {
  return <a href={`#/${route}`} aria-current={current === route ? 'page' : undefined} className={`rounded-xl px-3 py-2 text-center text-[10px] font-black ${current === route ? 'bg-[#FFF1CC] text-[#855D00]' : 'text-slate-500'}`}><span className="block text-xl">{icon}</span>{label}</a>;
}

function AccessDenied() {
  return <main className="min-h-[80vh] p-6 flex items-center justify-center"><section className="rounded-3xl bg-white p-8 text-center shadow-xl"><div className="text-5xl">🔐</div><h1 className="mt-3 text-xl font-black">Không có quyền truy cập</h1><a href="#/player" className="mt-4 inline-block font-black text-orange-600">Về game</a></section></main>;
}

export default function App() {
  return <MotionConfig reducedMotion="user"><AuthProvider><GameObservationProvider><div className="app-workspace"><AuthenticatedApp /></div><GlobalEventLog /></GameObservationProvider></AuthProvider></MotionConfig>;
}
