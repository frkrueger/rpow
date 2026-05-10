import { describe, it, expect } from 'vitest';
import { drawSpin } from '../src/longshot/randomness.js';

describe('long shot randomness', () => {
  it('drawSpin(1.0).outcome always returns true; hex is 16 hex chars', () => {
    for (let i = 0; i < 100; i++) {
      const d = drawSpin(1.0);
      expect(d.outcome).toBe(true);
      expect(d.hex).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('drawSpin(0.0).outcome always returns false; hex is 16 hex chars', () => {
    for (let i = 0; i < 100; i++) {
      const d = drawSpin(0.0);
      expect(d.outcome).toBe(false);
      expect(d.hex).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('drawSpin(0.475).outcome is approximately 47.5% true over many trials', () => {
    let trues = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) if (drawSpin(0.475).outcome) trues += 1;
    const fraction = trues / N;
    // Sampling noise: ±2σ for binomial(20000, 0.475) is roughly ±0.007
    expect(fraction).toBeGreaterThan(0.46);
    expect(fraction).toBeLessThan(0.49);
  });

  it('drawSpin(0.5).hex matches /^[0-9a-f]{16}$/ for many calls', () => {
    for (let i = 0; i < 50; i++) {
      const d = drawSpin(0.5);
      expect(d.hex).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
