export function registerPwa(): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  // Nhúng dưới đường dẫn con (AIV Bank /game/): không đăng ký service worker,
  // vì nó sẽ cache và chặn request của cả ứng dụng chủ.
  if (import.meta.env.BASE_URL !== '/' || window.self !== window.top) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(registration => {
      registration.update().catch(() => undefined);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) worker.postMessage({ type: 'SKIP_WAITING' });
        });
      });
    }).catch(() => undefined);
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
}
