import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../src/features/auth/api-client';

afterEach(() => vi.unstubAllGlobals());

it('cancels a request waiting for shared refresh without cancelling another caller', async () => {
  vi.stubGlobal('document', { cookie: '' });
  let finishRefresh!: (response: Response) => void;
  let notifyRefresh!: () => void;
  const refreshStarted = new Promise<void>(resolve => { notifyRefresh = resolve; });
  const refresh = new Promise<Response>(resolve => { finishRefresh = resolve; });
  const attempts: Record<string, number> = {};
  const fetch = vi.fn(async (path: string) => {
    if (path === '/api/v1/auth/refresh') { notifyRefresh(); return refresh; }
    attempts[path] = (attempts[path] ?? 0) + 1;
    return attempts[path] === 1 ? new Response('{}', { status: 401 }) : Response.json({ accepted: true });
  });
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  const cancelled = apiFetch('/first', { signal: controller.signal });
  const cancellation = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  await refreshStarted;
  const surviving = apiFetch('/second');
  controller.abort();
  try {
    await cancellation;
    expect(attempts['/first']).toBe(1);
  } finally {
    finishRefresh(new Response('{}', { status: 200 }));
    await expect(surviving).resolves.toEqual({ accepted: true });
  }
  expect(fetch.mock.calls.filter(([path]) => path === '/api/v1/auth/refresh')).toHaveLength(1);
});
