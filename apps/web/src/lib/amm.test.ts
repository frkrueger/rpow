import { describe, it, expect } from 'vitest';
import { minOut, formatUsdc, parseUsdcToBaseUnits, parsePercentToBps } from './amm.js';

describe('minOut', () => {
  it('returns 0 when quoteOut is 0', () => {
    expect(minOut(0n, 50)).toBe(0n);
  });
  it('returns quoteOut when slippage is 0', () => {
    expect(minOut(100n, 0)).toBe(100n);
  });
  it('subtracts 0.5% slippage (50 bps) on 100', () => {
    expect(minOut(100n, 50)).toBe(99n);
  });
  it('subtracts 1% (100 bps) on 10000', () => {
    expect(minOut(10000n, 100)).toBe(9900n);
  });
  it('floors toward zero on integer division', () => {
    // 10001 * 9950 / 10000 = 9950.995 → 9950
    expect(minOut(10001n, 50)).toBe(9950n);
  });
  it('handles large bigints without overflow', () => {
    const big = 1_000_000_000_000_000_000n;
    expect(minOut(big, 50)).toBe(995_000_000_000_000_000n);
  });
  it('returns 0n when slippage is 10000 bps (100%)', () => {
    expect(minOut(100n, 10000)).toBe(0n);
  });
});

describe('formatUsdc', () => {
  it('formats 0 as 0.00', () => {
    expect(formatUsdc('0')).toBe('0.00');
  });
  it('formats 1_000_000 as 1.00 (USDC = 6 decimals)', () => {
    expect(formatUsdc('1000000')).toBe('1.00');
  });
  it('formats 1_234_567_890 as 1234.57 (rounded down)', () => {
    expect(formatUsdc('1234567890')).toBe('1234.57');
  });
  it('formats 500_000 as 0.50', () => {
    expect(formatUsdc('500000')).toBe('0.50');
  });
  it('includes thousand separators for readability', () => {
    expect(formatUsdc('1234567890000')).toBe('1,234,567.89');
  });
});

describe('parseUsdcToBaseUnits', () => {
  it('parses "1" as "1000000"', () => {
    expect(parseUsdcToBaseUnits('1')).toBe('1000000');
  });
  it('parses "0.50" as "500000"', () => {
    expect(parseUsdcToBaseUnits('0.50')).toBe('500000');
  });
  it('parses "1.234567" as "1234567" (6 decimal max)', () => {
    expect(parseUsdcToBaseUnits('1.234567')).toBe('1234567');
  });
  it('throws on more than 6 decimal places', () => {
    expect(() => parseUsdcToBaseUnits('1.1234567')).toThrow();
  });
  it('throws on non-numeric', () => {
    expect(() => parseUsdcToBaseUnits('abc')).toThrow();
  });
  it('throws on negative', () => {
    expect(() => parseUsdcToBaseUnits('-1')).toThrow();
  });
});

describe('parsePercentToBps', () => {
  it('parses "0.5" as 50 bps', () => {
    expect(parsePercentToBps('0.5')).toBe(50);
  });
  it('parses "1" as 100 bps', () => {
    expect(parsePercentToBps('1')).toBe(100);
  });
  it('parses "0" as 0 bps', () => {
    expect(parsePercentToBps('0')).toBe(0);
  });
  it('parses "50" as 5000 bps (max allowed)', () => {
    expect(parsePercentToBps('50')).toBe(5000);
  });
  it('throws on > 50 percent', () => {
    expect(() => parsePercentToBps('51')).toThrow();
  });
  it('throws on negative', () => {
    expect(() => parsePercentToBps('-0.5')).toThrow();
  });
  it('throws on non-numeric', () => {
    expect(() => parsePercentToBps('abc')).toThrow();
  });
});
