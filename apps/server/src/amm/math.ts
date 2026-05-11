// Pure-bigint math for the constant-product AMM. No DB, no IO.
//
// Uniswap V2 fee convention: a swap with fee_bps=30 (0.3%) takes 3/1000 of the
// input asset's amount as the fee. The fee stays in the pool (it's not split
// out separately) — the pool's input reserve grows by the FULL input amount,
// which means the effective post-swap k strictly exceeds the pre-swap k for
// any positive fee. This is what gives LP holders yield.

/** Integer square root of a non-negative bigint (Newton's method). Returns
 *  floor(sqrt(n)). Throws if n is negative. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt: negative input');
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

export interface SwapInputs {
  reserveIn: bigint;
  reserveOut: bigint;
  amountIn: bigint;
  /** Fee numerator (default 997 = 0.3% fee). */
  feeNum?: bigint;
  /** Fee denominator (default 1000). */
  feeDen?: bigint;
}

/** Uniswap V2 constant-product swap output:
 *  amountOut = (reserveOut × amountIn × feeNum) / (reserveIn × feeDen + amountIn × feeNum)
 *  Floor-divided. Returns 0n for amountIn <= 0n. */
export function computeSwapOutput({
  reserveIn,
  reserveOut,
  amountIn,
  feeNum = 997n,
  feeDen = 1000n,
}: SwapInputs): bigint {
  if (amountIn <= 0n) return 0n;
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('computeSwapOutput: reserves must be positive');
  if (feeNum <= 0n || feeDen <= 0n || feeNum > feeDen) throw new Error('computeSwapOutput: invalid fee config');
  const inWithFee = amountIn * feeNum;
  const numerator = inWithFee * reserveOut;
  const denominator = reserveIn * feeDen + inWithFee;
  return numerator / denominator;
}

/** Fee paid (in `amountIn` units) for a swap. Returns floor(amountIn × (feeDen - feeNum) / feeDen). */
export function computeFeeIn(amountIn: bigint, feeNum: bigint = 997n, feeDen: bigint = 1000n): bigint {
  if (amountIn <= 0n) return 0n;
  return (amountIn * (feeDen - feeNum)) / feeDen;
}

/** Effective price impact in basis points, comparing spot price vs the
 *  effective rate experienced by the trade. Returns a non-negative bigint.
 *  Math: spot = reserveOut/reserveIn (out per in); effective = amountOut/amountIn.
 *  Impact = 10000 × (spot - effective) / spot. */
export function computePriceImpactBps(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
  amountOut: bigint,
): bigint {
  if (amountIn <= 0n || amountOut <= 0n) return 0n;
  if (reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const spotNumerator = reserveOut * amountIn;
  const effectiveNumerator = amountOut * reserveIn;
  if (spotNumerator <= effectiveNumerator) return 0n;
  return ((spotNumerator - effectiveNumerator) * 10_000n) / spotNumerator;
}

/** Reserve product k = R_in × R_out. The invariant after a swap must satisfy
 *  k_new ≥ k_old. */
export function poolK(rpow: bigint, usdc: bigint): bigint {
  return rpow * usdc;
}
