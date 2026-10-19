function cookie(name: string): string | undefined {
  return document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

// Khi nhúng trong AIV Bank, game được build với base `/game/` và API nằm ở
// `/game/api/...`. Mọi lời gọi trong code vẫn viết `/api/...`; chỉ đổi ở đây.
const EMBEDDED = import.meta.env.BASE_URL !== '/';

// AIV Bank đòi header này trên mọi request ghi (lớp CSRF của ứng dụng chủ).
function hostHeaders(headers: Headers): Headers {
  if (EMBEDDED) headers.set('X-AIVB-Client', 'web');
  return headers;
}

export function apiUrl(path: string): string {
  return path.startsWith('/api/') ? `${import.meta.env.BASE_URL}${path.slice(1)}` : path;
}

let refreshPromise: Promise<boolean> | undefined;

async function refreshSession(signal?: AbortSignal | null): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = fetch(apiUrl('/api/v1/auth/refresh'), {
      method: 'POST', credentials: 'include', headers: hostHeaders(new Headers({ 'x-csrf-token': cookie('csrf') ?? '' })),
      signal: AbortSignal.timeout(15_000),
    }).then(response => response.ok).catch(() => false).finally(() => { refreshPromise = undefined; });
  }
  if (!signal) return refreshPromise;
  signal.throwIfAborted();
  return new Promise<boolean>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    // A caller may cancel its wait without cancelling other callers' refresh.
    refreshPromise!.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) hostHeaders(headers).set('x-csrf-token', cookie('csrf') ?? '');
  const response = await fetch(apiUrl(path), { ...init, credentials: 'include', headers });
  if (response.status === 401 && retry && !path.includes('/auth/refresh') && await refreshSession(init.signal)) return apiFetch<T>(path, init, false);
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    if (payload && typeof payload === 'object' && 'error' in payload) {
      const error = payload.error;
      if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') message = error.message;
    }
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

export function stableDeviceId(): string {
  const key = 'jta_device_id';
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}
