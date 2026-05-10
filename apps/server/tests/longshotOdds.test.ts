import { describe, it, expect } from 'vitest';
import { ODDS_TIERS, winProbabilityFor, payoutMultipleFor, isValidOddsChoice } from '../src/longshot/odds.js';

describe('long shot odds', () => {
  it('exposes the four advertised odds tiers', () => {
    expect(ODDS_TIERS).toEqual(['1:1', '2:1', '3:1', '10:1']);
  });

  it('returns expected win probabilities (5% house edge)', () => {
    // p = 0.95 / (m + 1)
    expect(winProbabilityFor('1:1')).toBeCloseTo(0.475, 6);
    expect(winProbabilityFor('2:1')).toBeCloseTo(0.31666667, 6);
    expect(winProbabilityFor('3:1')).toBeCloseTo(0.2375, 6);
    expect(winProbabilityFor('10:1')).toBeCloseTo(0.08636364, 6);
  });

  it('returns the integer payout multiple', () => {
    expect(payoutMultipleFor('1:1')).toBe(1);
    expect(payoutMultipleFor('2:1')).toBe(2);
    expect(payoutMultipleFor('3:1')).toBe(3);
    expect(payoutMultipleFor('10:1')).toBe(10);
  });

  it('validates odds_choice', () => {
    expect(isValidOddsChoice('1:1')).toBe(true);
    expect(isValidOddsChoice('10:1')).toBe(true);
    expect(isValidOddsChoice('5:1')).toBe(false);
    expect(isValidOddsChoice('')).toBe(false);
    expect(isValidOddsChoice('  10:1  ')).toBe(false);
  });

  it('expected value per tier is exactly -5%', () => {
    for (const tier of ODDS_TIERS) {
      const p = winProbabilityFor(tier);
      const m = payoutMultipleFor(tier);
      const ev = p * m - (1 - p) * 1;
      expect(ev).toBeCloseTo(-0.05, 6);
    }
  });
});
