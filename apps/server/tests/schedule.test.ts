import { describe, it, expect } from 'vitest';
import {
  currentRewardBaseUnits,
  difficultyBitsForSupply,
  scheduleInfo,
  BASE_UNITS_PER_RPOW,
  MINT_BASE_REWARD_BASE_UNITS,
  MINT_DIFFICULTY_BITS_DEFAULT,
} from '../src/schedule.js';

const ONE_M_BU = 1_000_000n * BASE_UNITS_PER_RPOW;

describe('halving schedule (production defaults)', () => {
  it('difficulty is fixed at 24', () => {
    expect(MINT_DIFFICULTY_BITS_DEFAULT).toBe(24);
    expect(difficultyBitsForSupply(0n)).toBe(24);
    expect(difficultyBitsForSupply(10n * ONE_M_BU)).toBe(24);
  });

  it('initial reward is 1/128 RPOW = 7,812,500 base units', () => {
    expect(MINT_BASE_REWARD_BASE_UNITS).toBe(7_812_500n);
    expect(MINT_BASE_REWARD_BASE_UNITS).toBe(BASE_UNITS_PER_RPOW / 128n);
    expect(currentRewardBaseUnits(0n)).toBe(7_812_500n);
    expect(currentRewardBaseUnits(ONE_M_BU - 1n)).toBe(7_812_500n);
  });

  it('halves at each 1M-RPOW boundary', () => {
    expect(currentRewardBaseUnits(ONE_M_BU)).toBe(3_906_250n);
    expect(currentRewardBaseUnits(2n * ONE_M_BU)).toBe(1_953_125n);
    expect(currentRewardBaseUnits(3n * ONE_M_BU)).toBe(976_562n); // floor(1953125/2)
    expect(currentRewardBaseUnits(10n * ONE_M_BU)).toBe(7_629n);
  });

  it('reward floors at 0 once integer division collapses below 1', () => {
    // 7_812_500 = 5^9 * 2^2; integer-halved 23 times reaches 0.
    expect(currentRewardBaseUnits(23n * ONE_M_BU)).toBe(0n);
    expect(currentRewardBaseUnits(50n * ONE_M_BU)).toBe(0n);
  });

  it('respects test overrides', () => {
    expect(difficultyBitsForSupply(0n, { difficultyBits: 8 })).toBe(8);
    expect(currentRewardBaseUnits(0n, { baseRewardBaseUnits: 1000n })).toBe(1000n);
    // halvingIntervalRpow: 1 means each halving boundary is at 1 RPOW = 10^9 base units.
    // 1000n needs 10 halvings to floor to 0n. So minted must be >= 10 * BASE_UNITS_PER_RPOW.
    expect(currentRewardBaseUnits(10n * BASE_UNITS_PER_RPOW, { baseRewardBaseUnits: 1000n, halvingIntervalRpow: 1 })).toBe(0n);
    // And one halving short still has a reward.
    expect(currentRewardBaseUnits(9n * BASE_UNITS_PER_RPOW, { baseRewardBaseUnits: 1000n, halvingIntervalRpow: 1 })).toBe(1n);
  });

  describe('scheduleInfo', () => {
    it('at zero', () => {
      const s = scheduleInfo(0n);
      expect(s).toEqual({
        currentDifficultyBits: 24,
        currentRewardBaseUnits: 7_812_500n,
        halvingIndex: 0,
        nextHalvingAtBaseUnits: ONE_M_BU,
        baseUnitsToNextHalving: ONE_M_BU,
        nextRewardBaseUnits: 3_906_250n,
        isCapped: false,
        isMintable: true,
      });
    });

    it('mid-phase 1', () => {
      const s = scheduleInfo(ONE_M_BU + 250_000n * BASE_UNITS_PER_RPOW);
      expect(s.halvingIndex).toBe(1);
      expect(s.currentRewardBaseUnits).toBe(3_906_250n);
      expect(s.nextRewardBaseUnits).toBe(1_953_125n);
      expect(s.nextHalvingAtBaseUnits).toBe(2n * ONE_M_BU);
      expect(s.baseUnitsToNextHalving).toBe(750_000n * BASE_UNITS_PER_RPOW);
      expect(s.isMintable).toBe(true);
    });

    it('at the 21M cap', () => {
      const s = scheduleInfo(21n * ONE_M_BU);
      expect(s.isCapped).toBe(true);
      expect(s.isMintable).toBe(false);
      expect(s.baseUnitsToNextHalving).toBe(0n);
    });

    it('next halving is capped at maxSupply when within the last interval', () => {
      const cap = 21n * ONE_M_BU;
      const s = scheduleInfo(cap - 500_000n * BASE_UNITS_PER_RPOW);
      expect(s.nextHalvingAtBaseUnits).toBeLessThanOrEqual(cap);
    });
  });
});
