import { describe, it, expect } from 'vitest';
import {
  currentRewardBaseUnits,
  difficultyBitsForSupply,
  scheduleInfo,
  BASE_UNITS_PER_RPOW,
  MINT_BASE_REWARD_BASE_UNITS,
  MINT_DIFFICULTY_BITS_DEFAULT,
  MINT_SCHEDULE_OFFSET_RPOW,
  MINT_MAX_SUPPLY_RPOW,
} from '../src/schedule.js';

const ONE_M_BU = 1_000_000n * BASE_UNITS_PER_RPOW;
const OFFSET_BU = BigInt(MINT_SCHEDULE_OFFSET_RPOW) * BASE_UNITS_PER_RPOW;
const MAX_BU = BigInt(MINT_MAX_SUPPLY_RPOW) * BASE_UNITS_PER_RPOW;

describe('halving schedule (production defaults: 0.001 RPOW base, 9M offset, 19M cap)', () => {
  it('difficulty is fixed at 24', () => {
    expect(MINT_DIFFICULTY_BITS_DEFAULT).toBe(24);
    expect(difficultyBitsForSupply(0n)).toBe(24);
    expect(difficultyBitsForSupply(10n * ONE_M_BU)).toBe(24);
  });

  it('exposes the production constants', () => {
    expect(MINT_BASE_REWARD_BASE_UNITS).toBe(1_000_000n);
    expect(MINT_BASE_REWARD_BASE_UNITS).toBe(BASE_UNITS_PER_RPOW / 1000n);
    expect(MINT_SCHEDULE_OFFSET_RPOW).toBe(9_000_000);
    expect(MINT_MAX_SUPPLY_RPOW).toBe(19_000_000);
  });

  it('reward stays at 0.001 RPOW until minted reaches the offset + 1M', () => {
    expect(currentRewardBaseUnits(0n)).toBe(1_000_000n);
    expect(currentRewardBaseUnits(OFFSET_BU)).toBe(1_000_000n);                   // exactly at offset
    expect(currentRewardBaseUnits(OFFSET_BU + ONE_M_BU - 1n)).toBe(1_000_000n);   // last unit of epoch 0
  });

  it('halves at each 1M-RPOW boundary above the offset', () => {
    expect(currentRewardBaseUnits(OFFSET_BU + ONE_M_BU)).toBe(500_000n);          // 10M minted, halving 1
    expect(currentRewardBaseUnits(OFFSET_BU + 2n * ONE_M_BU)).toBe(250_000n);     // 11M, halving 2
    expect(currentRewardBaseUnits(OFFSET_BU + 5n * ONE_M_BU)).toBe(31_250n);      // 14M, halving 5
    expect(currentRewardBaseUnits(OFFSET_BU + 9n * ONE_M_BU)).toBe(1_953n);       // 18M, halving 9
  });

  it('reward floors at 0 once integer division collapses below 1', () => {
    // base 1_000_000n halved 20 times reaches 0
    expect(currentRewardBaseUnits(OFFSET_BU + 20n * ONE_M_BU)).toBe(0n);
    expect(currentRewardBaseUnits(OFFSET_BU + 50n * ONE_M_BU)).toBe(0n);
  });

  it('respects test overrides (offset=0 disables the offset)', () => {
    expect(difficultyBitsForSupply(0n, { difficultyBits: 8 })).toBe(8);
    expect(currentRewardBaseUnits(0n, { baseRewardBaseUnits: 1000n, scheduleOffsetRpow: 0 })).toBe(1000n);
    // halvingIntervalRpow: 1 means each halving boundary is at 1 RPOW = 10^9 base units.
    // 1000n needs 10 halvings to floor to 0n.
    expect(currentRewardBaseUnits(10n * BASE_UNITS_PER_RPOW, { baseRewardBaseUnits: 1000n, halvingIntervalRpow: 1, scheduleOffsetRpow: 0 })).toBe(0n);
    expect(currentRewardBaseUnits(9n * BASE_UNITS_PER_RPOW, { baseRewardBaseUnits: 1000n, halvingIntervalRpow: 1, scheduleOffsetRpow: 0 })).toBe(1n);
  });

  describe('scheduleInfo', () => {
    it('at zero (production defaults)', () => {
      const s = scheduleInfo(0n);
      expect(s).toEqual({
        currentDifficultyBits: 24,
        currentRewardBaseUnits: 1_000_000n,
        halvingIndex: 0,
        nextHalvingAtBaseUnits: OFFSET_BU + ONE_M_BU,    // 10M
        baseUnitsToNextHalving: OFFSET_BU + ONE_M_BU,
        nextRewardBaseUnits: 500_000n,
        isCapped: false,
        isMintable: true,
      });
    });

    it('mid-phase 0 (between offset and first halving)', () => {
      // 9.5M minted: still epoch 0
      const s = scheduleInfo(OFFSET_BU + 500_000n * BASE_UNITS_PER_RPOW);
      expect(s.halvingIndex).toBe(0);
      expect(s.currentRewardBaseUnits).toBe(1_000_000n);
      expect(s.nextRewardBaseUnits).toBe(500_000n);
      expect(s.nextHalvingAtBaseUnits).toBe(OFFSET_BU + ONE_M_BU);
      expect(s.baseUnitsToNextHalving).toBe(500_000n * BASE_UNITS_PER_RPOW);
      expect(s.isMintable).toBe(true);
    });

    it('mid-phase 1 (between first and second halving)', () => {
      // 10.25M minted: epoch 1, reward 0.0005
      const s = scheduleInfo(OFFSET_BU + ONE_M_BU + 250_000n * BASE_UNITS_PER_RPOW);
      expect(s.halvingIndex).toBe(1);
      expect(s.currentRewardBaseUnits).toBe(500_000n);
      expect(s.nextRewardBaseUnits).toBe(250_000n);
      expect(s.nextHalvingAtBaseUnits).toBe(OFFSET_BU + 2n * ONE_M_BU);   // 11M
      expect(s.baseUnitsToNextHalving).toBe(750_000n * BASE_UNITS_PER_RPOW);
      expect(s.isMintable).toBe(true);
    });

    it('at the 19M cap', () => {
      const s = scheduleInfo(MAX_BU);
      expect(s.isCapped).toBe(true);
      expect(s.isMintable).toBe(false);
      expect(s.baseUnitsToNextHalving).toBe(0n);
    });

    it('next halving is capped at maxSupply when within the last interval', () => {
      const s = scheduleInfo(MAX_BU - 500_000n * BASE_UNITS_PER_RPOW);
      expect(s.nextHalvingAtBaseUnits).toBeLessThanOrEqual(MAX_BU);
    });

    it('with offset disabled, halvings count from minted=0', () => {
      const s = scheduleInfo(ONE_M_BU, { scheduleOffsetRpow: 0 });
      expect(s.halvingIndex).toBe(1);
      expect(s.currentRewardBaseUnits).toBe(500_000n);
      expect(s.nextHalvingAtBaseUnits).toBe(2n * ONE_M_BU);
    });
  });
});
