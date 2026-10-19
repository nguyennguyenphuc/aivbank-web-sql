import { describe, expect, it } from 'vitest';
import { EVENT_LIMIT, initialObservations, observeGame, type AttemptScope, type GameObservation } from '../../src/features/analytics/game-observations';

function observe(events: GameObservation[], attempt?: AttemptScope) {
  return events.reduce((state, event, index) => observeGame(state, { event, now: index * 100, attempt }), initialObservations);
}

describe('app-wide history and current-attempt teaching observations', () => {
  it('retains bounded events without losing whole-attempt counters or move numbers', () => {
    const moves = EVENT_LIMIT + 5;
    const state = observe([
      { type: 'level_started', movesLeft: moves },
      ...Array.from({ length: moves }, (_, index): GameObservation => ({
        type: 'move_resolved', score: (index + 1) * 180, delta: 180, cascades: 1, movesLeft: moves - index - 1,
      })),
      { type: 'move_rejected', reason: 'no_match' },
    ]);
    expect(state.events).toHaveLength(EVENT_LIMIT);
    expect(state.events[0].sequence).toBe(state.count - EVENT_LIMIT + 1);
    expect(state.events.at(-1)?.sequence).toBe(moves + 2);
    expect(state.accepted).toBe(moves);
    expect(state.rejected).toBe(1);
    expect(state.movePoints).toBe(moves * 180);
    expect(state.cascades).toBe(moves);
    expect(state.trend).toHaveLength(30);
    expect(state.trend[0].move).toBe(moves - 29);
  });

  it('separates booster and end bonus points from per-swap analysis', () => {
    const state = observe([
      { type: 'level_started', movesLeft: 16 },
      { type: 'move_resolved', score: 180, delta: 180, cascades: 1, movesLeft: 15 },
      { type: 'booster_used', booster: 'hammer' },
      { type: 'booster_resolved', booster: 'hammer', score: 240, delta: 60, movesLeft: 15 },
      { type: 'level_completed', score: 2490, baseScore: 240, bonus: 2250, won: true },
    ]);
    expect(state.movePoints / state.accepted).toBe(180);
    expect(state.cascades).toBe(1);
    expect(state.score).toBe(2490);
    expect(state.trend).toEqual([{ move: 1, score: 180 }]);
  });

  it('does not present an unverified local win as a server outcome', () => {
    const pending = observe([
      { type: 'level_started', movesLeft: 16 },
      { type: 'level_completed', score: 1200, baseScore: 1200, bonus: 0, won: true },
      { type: 'verification_started' },
    ]);
    expect(pending.status).toBe('verifying');
    expect(pending.won).toBeNull();
    const unavailable = observeGame(pending, { event: { type: 'verification_failed', reason: 'unavailable' }, now: 400 });
    const rejected = observeGame(pending, { event: { type: 'verification_failed', reason: 'rejected' }, now: 400 });
    expect(unavailable.status).toBe('error');
    expect(rejected.status).toBe('rejected');
    expect(unavailable.won).toBeNull();
    expect(rejected.won).toBeNull();
    const verified = observeGame(pending, { event: { type: 'verification_completed', score: 900, won: false }, now: 400 });
    expect(verified.status).toBe('verified');
    expect(verified.score).toBe(900);
    expect(verified.won).toBe(false);
    expect(verified.events.at(-1)?.source).toBe('server-response');
  });

  it('preserves gameplay history and KPIs through navigation and dialogs', () => {
    const attempt: AttemptScope = { id: 'first', levelId: 1, mode: 'practice' };
    const played = observe([
      { type: 'level_started', movesLeft: 16 },
      { type: 'move_resolved', score: 180, delta: 180, cascades: 1, movesLeft: 15 },
    ], attempt);
    const navigation: GameObservation[] = [
      { type: 'screen_viewed', screen: 'map' },
      { type: 'dialog_opened', dialog: 'shop' },
      { type: 'dialog_opened', dialog: 'settings' },
      { type: 'screen_viewed', screen: 'classroom' },
      { type: 'screen_viewed', screen: 'analyst' },
      { type: 'screen_viewed', screen: 'practice' },
    ];
    const state = navigation.reduce((current, event, index) => observeGame(current, { event, now: 200 + index * 100 }), played);
    expect(state).toEqual({
      ...played, screen: 'practice', count: played.count + navigation.length,
      events: [
        ...played.events,
        ...navigation.map((event, index) => ({
          ...event, sequence: 3 + index, elapsedMs: 200 + index * 100, source: 'client', attempt: null,
        })),
      ],
    });
  });

  it('resets KPIs on same-level replay selection without resetting global history or time', () => {
    const first: AttemptScope = { id: 'first', levelId: 1, mode: 'practice' };
    const replay: AttemptScope = { ...first, id: 'replay' };
    const completed = observe([
      { type: 'attempt_selected' },
      { type: 'level_started', movesLeft: 16 },
      { type: 'move_resolved', score: 180, delta: 180, cascades: 2, movesLeft: 15 },
      { type: 'move_rejected', reason: 'no_match' },
      { type: 'level_completed', score: 2430, baseScore: 180, bonus: 2250, won: true },
    ], first);
    const selected = observeGame(completed, { event: { type: 'attempt_selected' }, attempt: replay, now: 800 });
    expect(selected).toMatchObject({
      currentAttempt: replay, startedAt: null, sessionStartedAt: 0,
      accepted: 0, rejected: 0, movePoints: 0, cascades: 0, score: 0, movesLeft: null,
      status: 'waiting', won: null, trend: [], count: 6,
    });
    expect(selected.events.slice(0, -1)).toEqual(completed.events);
    expect(selected.events.at(-1)).toMatchObject({ type: 'attempt_selected', attempt: replay, sequence: 6, elapsedMs: 800 });
    const started = observeGame(selected, { event: { type: 'level_started', movesLeft: 16 }, attempt: replay, now: 900 });
    const moved = observeGame(started, {
      event: { type: 'move_resolved', score: 60, delta: 60, cascades: 1, movesLeft: 15 }, attempt: replay, now: 1000,
    });
    expect(moved).toMatchObject({
      accepted: 1, rejected: 0, movePoints: 60, cascades: 1, score: 60, movesLeft: 15,
      status: 'playing', won: null, trend: [{ move: 1, score: 60 }], startedAt: 900, count: 8,
    });
    expect(moved.events.at(-1)).toMatchObject({ sequence: 8, elapsedMs: 1000 });
  });

  it('does not duplicate selection or start or reset progress under effect replay', () => {
    const attempt: AttemptScope = { id: 'first', levelId: 1, mode: 'ranked' };
    const selected = observe([{ type: 'attempt_selected' }], attempt);
    expect(observeGame(selected, { event: { type: 'attempt_selected' }, attempt, now: 100 })).toEqual(selected);
    const started = observeGame(selected, { event: { type: 'level_started', movesLeft: 16 }, attempt, now: 200 });
    const moved = observeGame(started, {
      event: { type: 'move_resolved', score: 180, delta: 180, cascades: 1, movesLeft: 15 }, attempt, now: 300,
    });
    const reselected = observeGame(moved, { event: { type: 'attempt_selected' }, attempt, now: 400 });
    const restarted = observeGame(reselected, { event: { type: 'level_started', movesLeft: 16 }, attempt, now: 500 });
    expect(restarted).toEqual(moved);
    const rejected = observeGame(restarted, { event: { type: 'move_rejected', reason: 'no_match' }, attempt, now: 600 });
    expect(rejected).toMatchObject({ count: 4, startedAt: 200, accepted: 1, rejected: 1, score: 180 });
    expect(rejected.events.at(-1)).toMatchObject({ sequence: 4, elapsedMs: 600 });
  });

  it('ignores old-attempt moves and outcomes both before and after the next attempt starts', () => {
    const first: AttemptScope = { id: 'first', levelId: 1, mode: 'ranked' };
    const next: AttemptScope = { id: 'next', levelId: 2, mode: 'ranked' };
    const previous = observe([{ type: 'level_started', movesLeft: 16 }], first);
    const selected = observeGame(previous, { event: { type: 'attempt_selected' }, attempt: next, now: 100 });
    const started = observeGame(selected, { event: { type: 'level_started', movesLeft: 12 }, attempt: next, now: 200 });
    const moved = observeGame(started, {
      event: { type: 'move_resolved', score: 60, delta: 60, cascades: 1, movesLeft: 11 }, attempt: next, now: 300,
    });
    const lateEvents: GameObservation[] = [
      { type: 'move_resolved', score: 999, delta: 999, cascades: 3, movesLeft: 0 },
      { type: 'level_completed', score: 999, baseScore: 999, bonus: 0, won: true },
      { type: 'verification_completed', score: 999, won: true },
    ];
    for (const current of [selected, moved]) {
      const result = lateEvents.reduce((state, event, index) => observeGame(state, { event, attempt: first, now: 400 + index * 100 }), current);
      expect(result).toEqual(current);
    }
  });
});
