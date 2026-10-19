import type { TelemetryIngestEvent } from '../../../shared/contracts/telemetry';
import { ApiError, apiFetch } from '../auth/api-client';
import { restoreGameplayTelemetry } from './gameplay-telemetry-payload';

const PREFIX = 'jelly-gameplay-outbox-v1:';
const LOSS_KEY = 'jelly-gameplay-outbox-loss-v1';
const LIMIT = 1000;
export type TelemetryProblem = 'offline' | 'retrying' | 'rejected' | 'storage' | 'full' | 'corrupt';
export interface TelemetrySyncStatus { pending: number; signedIn: boolean; problem?: TelemetryProblem; loss: boolean }

// One key per event avoids lost read/modify/write updates between tabs. Duplicate
// sends across tabs are safe because eventId is retained until acknowledgement.
export class GameplayTelemetryClient {
  private accountId?: string;
  private listener?: (status: TelemetrySyncStatus) => void;
  private timer?: number;
  private request?: AbortController;
  private running = false;
  private failures = 0;
  private blocked = false;
  private problem?: TelemetryProblem;
  private loss = false;
  private readonly wake = () => { if (!this.blocked) this.schedule(0); };
  private readonly changed = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(PREFIX) || event.key === LOSS_KEY) {
      this.publish();
      if (!this.timer) this.wake();
    }
  };

  start(accountId: string | undefined, listener: (status: TelemetrySyncStatus) => void) {
    this.accountId = accountId;
    this.listener = listener;
    this.blocked = false;
    this.failures = 0;
    this.problem = undefined;
    window.addEventListener('online', this.wake);
    window.addEventListener('storage', this.changed);
    this.publish();
    this.schedule(0);
    return () => {
      this.listener = undefined;
      this.accountId = undefined;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.request?.abort();
      window.removeEventListener('online', this.wake);
      window.removeEventListener('storage', this.changed);
    };
  }

  enqueue(accountId: string, event: TelemetryIngestEvent) {
    try {
      if (this.keys().length >= LIMIT) { this.problem = 'full'; this.noteLoss(); }
      else localStorage.setItem(`${PREFIX}${accountId}:${event.occurredAt}:${String(event.payload.sequence).padStart(12, '0')}:${event.eventId}`, JSON.stringify(event));
    } catch { this.problem = 'storage'; this.noteLoss(); }
    this.publish();
    // New gameplay must not bypass an existing backoff or a permanent error.
    if (!this.timer && !this.blocked) this.schedule(0);
  }

  retry = () => {
    this.blocked = false;
    this.problem = undefined;
    this.failures = 0;
    this.publish();
    this.schedule(0);
  };

  private noteLoss() {
    this.loss = true;
    try { localStorage.setItem(LOSS_KEY, '1'); } catch { /* The visible warning still survives for this page. */ }
  }

  private keys(accountId?: string) {
    const prefix = accountId ? `${PREFIX}${accountId}:` : PREFIX;
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    return keys;
  }

  private publish() {
    if (!this.listener) return;
    let pending = 0;
    try {
      pending = this.keys(this.accountId).length;
      this.loss ||= localStorage.getItem(LOSS_KEY) === '1';
    } catch { this.problem = 'storage'; }
    this.listener({ pending, signedIn: Boolean(this.accountId), problem: this.problem, loss: this.loss });
  }

  private schedule(delay: number) {
    if (!this.listener || !this.accountId || this.blocked) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = undefined; void this.flush(); }, delay);
  }

  private async flush() {
    if (this.running || !this.accountId || !this.listener || this.blocked) return;
    if (!navigator.onLine) { this.problem = 'offline'; this.publish(); return; }
    this.running = true;
    try {
      while (this.accountId && this.listener && !this.blocked) {
        const accountId = this.accountId;
        let next: { key: string; event: TelemetryIngestEvent } | undefined;
        try {
          const key = this.keys(accountId).sort()[0];
          const raw = key ? localStorage.getItem(key) : null;
          if (key && raw !== null) next = { key, event: restoreGameplayTelemetry(raw) };
        } catch { this.problem = 'corrupt'; this.blocked = true; break; }
        if (!next) { this.problem = undefined; break; }
        const controller = new AbortController();
        this.request = controller;
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          const acknowledgement = await apiFetch<unknown>('/api/v1/analytics/events', {
            method: 'POST', headers: { 'x-telemetry-account-id': accountId },
            body: JSON.stringify(next.event), signal: controller.signal,
          });
          if (!acknowledgement || typeof acknowledgement !== 'object' || !('accepted' in acknowledgement) || acknowledgement.accepted !== true) throw new Error('Observation delivery was not acknowledged');
          // Remove the exact acknowledged record, never another account's queue.
          localStorage.removeItem(next.key);
          this.failures = 0;
          this.problem = undefined;
        } catch (cause) {
          if (this.accountId !== accountId || !this.listener) break;
          const permanent = cause instanceof ApiError && cause.status < 500 && ![408, 425, 429].includes(cause.status);
          this.problem = permanent ? 'rejected' : 'retrying';
          this.blocked = permanent;
          if (!permanent) {
            this.failures++;
            this.schedule(Math.min(30000, 1000 * 2 ** Math.min(this.failures - 1, 5)));
          }
          break;
        } finally { clearTimeout(timeout); this.request = undefined; }
        this.publish();
      }
    } finally {
      this.running = false;
      this.publish();
      // A new account may have activated while the old request was aborting.
      if (!this.timer && !this.blocked && this.accountId && !this.problem) {
        try { if (this.keys(this.accountId).length) this.schedule(0); } catch { this.problem = 'storage'; this.publish(); }
      }
    }
  }
}
