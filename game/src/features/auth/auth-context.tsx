import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SessionBundle, SessionPrincipal } from '../../../shared/contracts/auth';
import { apiFetch, stableDeviceId } from './api-client';

/** Game đang được AIV Bank phục vụ dưới đường dẫn con (vd. `/game/`). */
export const EMBEDDED_IN_AIVB = import.meta.env.BASE_URL !== '/';

/**
 * Đăng nhập bằng phiên AIV Bank: xin vé ở ứng dụng chủ (cùng origin, cookie
 * phiên AIV Bank tự đi kèm) rồi đổi vé lấy phiên game. Chạy mỗi lần mở để
 * phiên game luôn khớp người đang đăng nhập AIV Bank.
 */
async function aivbSso(): Promise<SessionPrincipal> {
  const response = await fetch('/game-sso/token', {
    method: 'POST', credentials: 'same-origin', headers: { 'X-AIVB-Client': 'web', accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Hãy đăng nhập AIV Bank rồi mở lại tab Trò chơi.');
  const { ticket } = await response.json() as { ticket: string };
  const bundle = await apiFetch<SessionBundle>('/api/v1/auth/aivb-sso', {
    method: 'POST', body: JSON.stringify({ ticket, deviceId: stableDeviceId() }),
  }, false);
  return bundle.principal;
}

interface AuthContextValue {
  principal?: SessionPrincipal;
  ready: boolean;
  error?: string;
  continueAsGuest: (displayName?: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<SessionPrincipal>();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (EMBEDDED_IN_AIVB) {
      aivbSso().then(setPrincipal).catch(cause => {
        setPrincipal(undefined);
        setError(cause instanceof Error ? cause.message : 'Không đăng nhập được bằng tài khoản AIV Bank');
      }).finally(() => setReady(true));
      return;
    }
    apiFetch<{ principal: SessionPrincipal | null }>('/api/v1/auth/session').then(result => setPrincipal(result.principal ?? undefined)).catch(() => undefined).finally(() => setReady(true));
  }, []);

  const continueAsGuest = useCallback(async (displayName?: string) => {
    setError(undefined);
    try {
      const bundle = await apiFetch<SessionBundle>('/api/v1/auth/guest', { method: 'POST', body: JSON.stringify({ deviceId: stableDeviceId(), displayName }) });
      setPrincipal(bundle.principal);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Không thể tạo tài khoản khách'); throw cause; }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setError(undefined);
    try {
      const bundle = await apiFetch<SessionBundle>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password, deviceId: stableDeviceId() }) });
      setPrincipal(bundle.principal);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Đăng nhập thất bại'); throw cause; }
  }, []);

  const logout = useCallback(async () => {
    await apiFetch('/api/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
    setPrincipal(undefined);
  }, []);

  const value = useMemo(() => ({ principal, ready, error, continueAsGuest, login, logout }), [principal, ready, error, continueAsGuest, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
