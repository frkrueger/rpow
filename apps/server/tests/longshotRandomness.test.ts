import { describe, it, expect } from 'vitest';
import { rollSpin, randomValueHex } from '../src/longshot/randomness.js';

describe('long shot randomness', () => {
  it('rollSpin(1.0) always returns true', () => {
    for (let i = 0; i < 100; i++) {
      expect(rollSpin(1.0)).toBe(true);
    }
  });

  it('rollSpin(0.0) always returns false', () => {
    for (let i = 0; i < 100; i++) {
      expect(rollSpin(0.0)).toBe(false);
    }
  });

  it('rollSpin(0.475) is approximately 47.5% true over many trials', () => {
    let trues = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) if (rollSpin(0.475)) trues += 1;
    const fraction = trues / N;
    // Sampling noise: ±2σ for binomial(20000, 0.475) is roughly ±0.007
    expect(fraction).toBeGreaterThan(0.46);
    expect(fraction).toBeLessThan(0.49);
  });

  it('randomValueHex returns 16 hex chars', () => {
    for (let i = 0; i < 50; i++) {
      const h = randomValueHex();
      expect(h).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
