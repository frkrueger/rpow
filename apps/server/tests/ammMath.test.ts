import { describe, it, expect } from 'vitest';
import {
  isqrt,
  computeSwapOutput,
  computeFeeIn,
  computePriceImpactBps,
  poolK,
} from '../src/amm/math.js';

describe('isqrt', () => {
  it('returns 0 for 0, 1 for 1', () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
  });

  it('perfect squares', () => {
    expect(isqrt(4n)).toBe(2n);
    expect(isqrt(9n)).toBe(3n);
    expect(isqrt(16n)).toBe(4n);
    expect(isqrt(100n)).toBe(10n);
    expect(isqrt(1_000_000n)).toBe(1000n);
  });

  it('floors non-square values', () => {
    expect(isqrt(2n)).toBe(1n);
    expect(isqrt(3n)).toBe(1n);
    expect(isqrt(8n)).toBe(2n);
    expect(isqrt(10n)).toBe(3n);
    expect(isqrt(99n)).toBe(9n);
  });

  it('handles large bigints', () => {
    // 10^18 has sqrt = 10^9 exactly.
    expect(isqrt(10n ** 18n)).toBe(10n ** 9n);
    // 10^30 → 10^15
    expect(isqrt(10n ** 30n)).toBe(10n ** 15n);
  });

  it('throws on negative input', () => {
    expect(() => isqrt(-1n)).toThrow();
  });
});

describe('computeSwapOutput', () => {
  it('returns 0n for non-positive amountIn', () => {
    expect(computeSwapOutput({ reserveIn: 100n, reserveOut: 100n, amountIn: 0n })).toBe(0n);
    expect(computeSwapOutput({ reserveIn: 100n, reserveOut: 100n, amountIn: -1n })).toBe(0n);
  });

  it('throws on non-positive reserves', () => {
    expect(() => computeSwapOutput({ reserveIn: 0n, reserveOut: 100n, amountIn: 1n })).toThrow();
    expect(() => computeSwapOutput({ reserveIn: 100n, reserveOut: 0n, amountIn: 1n })).toThrow();
  });

  it('matches no-fee constant product when feeNum=feeDen', () => {
    // No fee → standard x*y=k: amountOut = R_out × amountIn / (R_in + amountIn).
    const out = computeSwapOutput({
      reserveIn: 10_000n,
      reserveOut: 10_000n,
      amountIn: 1000n,
      feeNum: 1n,
      feeDen: 1n,
    });
    // 10000 * 1000 / (10000 + 1000) = 10_000_000 / 11_000 = 909 (floor)
    expect(out).toBe(909n);
  });

  it('with 0.3% fee: output is strictly less than the no-fee output', () => {
    const noFee = computeSwapOutput({
      reserveIn: 10_000n, reserveOut: 10_000n, amountIn: 1000n,
      feeNum: 1n, feeDen: 1n,
    });
    const withFee = computeSwapOutput({
      reserveIn: 10_000n, reserveOut: 10_000n, amountIn: 1000n,
    });
    expect(withFee).toBeLessThan(noFee);
  });

  it('invariant: new k >= old k for any positive amountIn', () => {
    const Rin = 10_000_000n;
    const Rout = 10_000_000n;
    const oldK = Rin * Rout;
    for (const amountIn of [1n, 100n, 10_000n, 1_000_000n]) {
      const out = computeSwapOutput({ reserveIn: Rin, reserveOut: Rout, amountIn });
      const newRin = Rin + amountIn;       // full amountIn added (fee stays in pool)
      const newRout = Rout - out;
      const newK = newRin * newRout;
      expect(newK).toBeGreaterThanOrEqual(oldK);
    }
  });

  it('small swap on huge pool: minimal price impact', () => {
    const out = computeSwapOutput({
      reserveIn: 10n ** 12n,
      reserveOut: 10n ** 12n,
      amountIn: 1000n,
    });
    // Effective rate close to 1:1 (minus 0.3% fee). Expect out ~= 996-997.
    expect(out).toBeGreaterThanOrEqual(990n);
    expect(out).toBeLessThanOrEqual(997n);
  });
});

describe('computeFeeIn', () => {
  it('0n for non-positive', () => {
    expect(computeFeeIn(0n)).toBe(0n);
    expect(computeFeeIn(-100n)).toBe(0n);
  });

  it('0.3% of 1000 → 3', () => {
    expect(computeFeeIn(1000n)).toBe(3n);
  });

  it('0.3% of 1_000_000 → 3000', () => {
    expect(computeFeeIn(1_000_000n)).toBe(3000n);
  });
});

describe('computePriceImpactBps', () => {
  it('0n when inputs are zero', () => {
    expect(computePriceImpactBps(100n, 100n, 0n, 0n)).toBe(0n);
  });

  it('tiny swap → small bps', () => {
    const Rin = 10n ** 12n;
    const Rout = 10n ** 12n;
    const amountIn = 1000n;
    const amountOut = computeSwapOutput({ reserveIn: Rin, reserveOut: Rout, amountIn });
    const bps = computePriceImpactBps(Rin, Rout, amountIn, amountOut);
    // Mostly the 30 bps fee; impact from pool depth is negligible.
    expect(bps).toBeGreaterThanOrEqual(29n);
    expect(bps).toBeLessThanOrEqual(40n);
  });

  it('huge swap → large bps', () => {
    const Rin = 1000n;
    const Rout = 1000n;
    const amountIn = 1000n; // doubling Rin
    const amountOut = computeSwapOutput({ reserveIn: Rin, reserveOut: Rout, amountIn });
    const bps = computePriceImpactBps(Rin, Rout, amountIn, amountOut);
    expect(bps).toBeGreaterThan(4000n); // 40%+
  });
});

describe('poolK', () => {
  it('multiplies', () => {
    expect(poolK(10n, 100n)).toBe(1000n);
    expect(poolK(10n ** 9n, 10n ** 6n)).toBe(10n ** 15n);
  });
});
