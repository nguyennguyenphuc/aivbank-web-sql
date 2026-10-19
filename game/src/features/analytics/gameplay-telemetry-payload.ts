import type { TelemetryIngestEvent } from '../../../shared/contracts/telemetry';
import type { ObservedEvent } from './game-observations';

const fields: Record<string, readonly string[]> = {
  attempt_selected: [], level_started: ['movesLeft'], move_rejected: ['reason'],
  move_resolved: ['score', 'delta', 'cascades', 'movesLeft'],
  booster_used: ['booster'], booster_failed: ['booster'],
  booster_resolved: ['booster', 'score', 'delta', 'movesLeft'], board_shuffled: [],
  level_completed: ['score', 'baseScore', 'bonus', 'won'], verification_started: [],
  verification_completed: ['score', 'won'], verification_failed: ['reason'], start_failed: [],
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Both live and restored records pass the same scalar allowlist. No request bodies or tokens.
function observation(value: unknown): Record<string, unknown> | null {
  if (!object(value) || typeof value.type !== 'string' || !Object.hasOwn(fields, value.type)) return null;
  const result: Record<string, unknown> = { type: value.type };
  for (const key of fields[value.type]) {
    const item = value[key];
    if (key === 'won' ? typeof item !== 'boolean'
      : key === 'booster' ? typeof item !== 'string' || !['hammer', 'shuffle', 'lightning', 'extraMoves'].includes(item)
      : key === 'reason' ? typeof item !== 'string' || !(value.type === 'move_rejected' ? ['not_adjacent', 'blocked', 'no_match'] : ['rejected', 'unavailable']).includes(item)
      : !number(item)) return null;
    result[key] = item;
  }
  return result;
}

export function gameplayTelemetry(row: ObservedEvent, sessionId: string): TelemetryIngestEvent | null {
  const facts = observation(row);
  if (!facts) return null;
  return {
    eventId: crypto.randomUUID(), eventName: 'game_observation', schemaVersion: 1,
    occurredAt: new Date().toISOString(), source: 'h5',
    payload: {
      sessionId, sequence: row.sequence, elapsedMs: Math.round(row.elapsedMs),
      attempt: row.attempt ? { id: row.attempt.id, levelId: row.attempt.levelId, mode: row.attempt.mode } : null,
      observation: facts,
    },
  };
}

export function restoreGameplayTelemetry(raw: string): TelemetryIngestEvent {
  const value: unknown = JSON.parse(raw);
  if (!object(value) || value.eventName !== 'game_observation' || value.source !== 'h5' || value.schemaVersion !== 1
    || typeof value.eventId !== 'string' || !uuid.test(value.eventId)
    || typeof value.occurredAt !== 'string' || !Number.isFinite(Date.parse(value.occurredAt)) || !object(value.payload)) throw new Error('Invalid saved observation');
  const payload = value.payload;
  const facts = observation(payload.observation);
  if (!facts || typeof payload.sessionId !== 'string' || !uuid.test(payload.sessionId)
    || !number(payload.sequence) || !Number.isInteger(payload.sequence) || payload.sequence < 1 || !number(payload.elapsedMs)) throw new Error('Invalid saved observation');
  let attempt = null;
  if (payload.attempt !== null) {
    const scope = payload.attempt;
    if (!object(scope) || typeof scope.id !== 'string' || !uuid.test(scope.id) || !number(scope.levelId)
      || !Number.isInteger(scope.levelId) || (scope.mode !== 'practice' && scope.mode !== 'ranked')) throw new Error('Invalid saved attempt');
    attempt = { id: scope.id, levelId: scope.levelId, mode: scope.mode };
  }
  return {
    eventId: value.eventId, eventName: 'game_observation', schemaVersion: 1, occurredAt: value.occurredAt, source: 'h5',
    payload: { sessionId: payload.sessionId, sequence: payload.sequence, elapsedMs: payload.elapsedMs, attempt, observation: facts },
  };
}
