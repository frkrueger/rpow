import { randomBytes } from 'node:crypto';

const DENOM = 1_000_000_000n;

export interface SpinDraw {
  outcome: boolean;
  /** 16 lowercase hex chars — the actual 8 bytes that determined the outcome. */
  hex: string;
}

/**
 * Draw 8 cryptographically secure random bytes. Returns whether the bucket
 * derived from those bytes is below the win threshold for probability `p`,
 * AND the hex encoding of the SAME bytes — so the audit log accurately
 * reflects what the server saw at decision time.
 */
export function drawSpin(p: number): SpinDraw {
  const buf = randomBytes(8);
  const hex = buf.toString('hex');
  if (p <= 0) return { outcome: false, hex };
  if (p >= 1) return { outcome: true, hex };
  const big = buf.readBigUInt64BE(0);
  const bucket = big % DENOM;
  const threshold = BigInt(Math.floor(p * Number(DENOM)));
  return { outcome: bucket < threshold, hex };
}
