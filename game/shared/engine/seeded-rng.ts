export interface SeededRandom {
  readonly state: number;
  next(): number;
  integer(maxExclusive: number): number;
}

export function normalizeSeed(seed: number | string): number {
  if (typeof seed === 'number') return (Number.isFinite(seed) ? seed : 0) >>> 0 || 0x6d2b79f5;
  let hash = 2_166_136_261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0 || 0x6d2b79f5;
}

export function createSeededRandom(seed: number | string): SeededRandom {
  let state = normalizeSeed(seed);
  return {
    get state() { return state >>> 0; },
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    },
    integer(maxExclusive: number) {
      if (!Number.isInteger(maxExclusive) || maxExclusive < 1) throw new Error('maxExclusive must be positive');
      return Math.floor(this.next() * maxExclusive);
    },
  };
}

export function shuffleSeeded<T>(items: readonly T[], random: SeededRandom): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const target = random.integer(index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}
