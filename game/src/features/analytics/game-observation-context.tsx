import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { initialObservations, observeGame, type AttemptScope, type GameMode, type GameObservation, type ObservationState } from './game-observations';
import { useAuth } from '../auth/auth-context';
import { GameplayTelemetryClient, type TelemetrySyncStatus } from './gameplay-telemetry-client';
import { gameplayTelemetry } from './gameplay-telemetry-payload';

interface ObservationStudio {
  state: ObservationState;
  record: (event: GameObservation, attempt?: AttemptScope) => void;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  language: 'vi' | 'en';
  setLanguage: Dispatch<SetStateAction<'vi' | 'en'>>;
  sync: TelemetrySyncStatus;
  retrySync: () => void;
}
const StudioContext = createContext<ObservationStudio | null>(null);
const AttemptContext = createContext<AttemptScope | undefined>(undefined);

export function GameObservationProvider({ children }: { children: ReactNode }) {
  const { principal, ready } = useAuth();
  const accountId = ready ? principal?.accountId : undefined;
  const [state, setState] = useState(initialObservations);
  const current = useRef(initialObservations);
  const [sessionId] = useState(() => crypto.randomUUID());
  const [telemetry] = useState(() => new GameplayTelemetryClient());
  const [sync, setSync] = useState<TelemetrySyncStatus>({ pending: 0, signedIn: false, loss: false });
  useEffect(() => telemetry.start(accountId, setSync), [accountId, telemetry]);
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState<'vi' | 'en'>('vi');
  const record = useCallback((event: GameObservation, attempt?: AttemptScope) => {
    // Reduce once at the call boundary, not inside React's replayable updater.
    const next = observeGame(current.current, { event, attempt, now: performance.now() });
    if (next === current.current) return;
    current.current = next;
    setState(next);
    const row = next.events.at(-1);
    if (accountId && row) {
      const payload = gameplayTelemetry(row, sessionId);
      if (payload) telemetry.enqueue(accountId, payload);
    }
  }, [accountId, sessionId, telemetry]);
  const value = useMemo(() => ({ state, record, open, setOpen, language, setLanguage, sync, retrySync: telemetry.retry }), [state, record, open, language, sync, telemetry]);
  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

export function GameAttemptScope({ levelId, mode, children }: { levelId: number; mode: GameMode; children: ReactNode }) {
  const [id] = useState(() => crypto.randomUUID());
  const scope = useMemo(() => ({ id, levelId, mode }), [id, levelId, mode]);
  const { record } = useObservationStudio();
  useLayoutEffect(() => { record({ type: 'attempt_selected' }, scope); }, [record, scope]);
  return <AttemptContext.Provider value={scope}>{children}</AttemptContext.Provider>;
}

export function useObservationStudio() {
  const studio = useContext(StudioContext);
  if (!studio) throw new Error('Observations require GameObservationProvider');
  return studio;
}

export function useGameObservation() {
  const { record } = useObservationStudio();
  const attempt = useContext(AttemptContext);
  return useCallback((event: GameObservation) => record(event, attempt), [record, attempt]);
}
