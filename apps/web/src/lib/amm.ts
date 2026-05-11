/**
 * Compute the min-out amount given a quote and a slippage in basis points.
 * Pure integer math: `floor(quoteOut * (10000 - slippageBps) / 10000)`.
 * Used to populate `min_rpow_out` / `min_usdc_out` / `min_lp_out` in AMM
 * write requests so the server rejects slippage drift.
 */
export function minOut(quoteOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 10000) {
    throw new Error(`slippageBps out of range: ${slippageBps}`);
  }
  return (quoteOut * BigInt(10000 - slippageBps)) / 10000n;
}

const USDC_DECIMALS = 6;
const USDC_DIVISOR = 1_000_000n;

/**
 * Format USDC base units (6-decimal) as a human-readable string with
 * thousand separators and 2 fractional digits. Rounds toward zero —
 * never overstate balances.
 */
export function formatUsdc(baseUnits: string): string {
  const n = BigInt(baseUnits);
  const whole = n / USDC_DIVISOR;
  // Two fractional digits → keep 2 of the 6 decimals, rounding to nearest.
  const remainder = n % USDC_DIVISOR;
  const fraction = (remainder + 5000n) / 10_000n; // round to nearest
  // Apply thousand separators only for numbers >= 10000.
  let wholeStr = whole.toString();
  if (whole >= 10000n) {
    wholeStr = wholeStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  const fracStr = fraction.toString().padStart(2, '0');
  return `${wholeStr}.${fracStr}`;
}

/**
 * Parse a decimal USDC string (e.g. "1.50") into base units (e.g. "1500000").
 * Throws on bad input: more than 6 decimal places, non-numeric, negative.
 */
export function parseUsdcToBaseUnits(s: string): string {
  if (!/^\d+(\.\d{1,6})?$/.test(s)) {
    throw new Error(`invalid USDC amount: ${s}`);
  }
  const [whole, frac = ''] = s.split('.');
  const padded = (frac + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  const combined = BigInt(whole) * USDC_DIVISOR + BigInt(padded || '0');
  return combined.toString();
}

/**
 * Parse a percent string (e.g. "0.5") to basis points (e.g. 50). Validates
 * range [0, 50] percent (= [0, 5000] bps). Throws on bad input.
 */
export function parsePercentToBps(s: string): number {
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`invalid percent: ${s}`);
  }
  const percent = Number(s);
  if (!Number.isFinite(percent) || percent < 0 || percent > 50) {
    throw new Error(`percent out of range [0, 50]: ${s}`);
  }
  return Math.round(percent * 100);
}
