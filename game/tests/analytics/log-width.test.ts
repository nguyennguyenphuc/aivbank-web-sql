import { describe, expect, it } from 'vitest';
import { GAME_MIN, LOG_MIN, clampLogWidth } from '../../src/features/analytics/log-width';

describe('resizable data panel width', () => {
  it('keeps a dragged width that fits', () => {
    expect(clampLogWidth(600, 1600)).toBe(600);
    expect(clampLogWidth(512.4, 1600)).toBe(512);
  });

  it('never squeezes the data panel below its floor', () => {
    expect(clampLogWidth(40, 1600)).toBe(LOG_MIN);
  });

  it('always leaves the board its minimum width', () => {
    expect(clampLogWidth(1500, 1600)).toBe(1600 - GAME_MIN);
  });

  it('falls back to the floor when the window cannot fit both', () => {
    expect(clampLogWidth(500, LOG_MIN + GAME_MIN - 50)).toBe(LOG_MIN);
  });

  it('treats garbage from storage as the floor, not NaN px', () => {
    expect(clampLogWidth(Number.NaN, 1600)).toBe(LOG_MIN);
    expect(clampLogWidth(Number.POSITIVE_INFINITY, 1600)).toBe(LOG_MIN);
  });
});
