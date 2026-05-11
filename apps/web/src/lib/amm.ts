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
 * Format USDC base units (6-decimal) as a human-readable decimal string
 * with exactly two fractional digits. Rounds to nearest cent (half-up).
 * No thousand separators — keep display predictable across magnitudes.
 */
export function formatUsdc(baseUnits: string): string {
  const n = BigInt(baseUnits);
  // Round to nearest cent by adding half a cent (5000 base units) before
  // dividing down to cents. Handles carry past .99 → 1.00 correctly.
  const cents = (n + 5000n) / 10_000n;
  const whole = cents / 100n;
  const fraction = cents % 100n;
  return `${whole.toString()}.${fraction.toString().padStart(2, '0')}`;
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
