import { randomBytes } from 'node:crypto';

const DENOM = 1_000_000_000n;

/**
 * Roll a uniform random number in [0, 1) and return true if < p.
 * Uses Node's CSPRNG (crypto.randomBytes) — cryptographically secure.
 */
export function rollSpin(p: number): boolean {
  if (p <= 0) return false;
  if (p >= 1) return true;
  const buf = randomBytes(8);
  const big = buf.readBigUInt64BE(0);
  const bucket = big % DENOM;
  const threshold = BigInt(Math.floor(p * Number(DENOM)));
  return bucket < threshold;
}

/**
 * Returns 8 random bytes as 16 lowercase hex chars.
 * Stored on each bet for transparency / public log.
 */
export function randomValueHex(): string {
  return randomBytes(8).toString('hex');
}
