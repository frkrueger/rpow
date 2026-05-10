import { randomBytes } from 'node:crypto';

export interface FlipDraw {
  /** True iff the challenger wins (byte LSB === 1). */
  challengerWins: boolean;
  /** Lowercase two-char hex of the single byte drawn. */
  hex: string;
}

/**
 * Draw one cryptographically secure byte; LSB picks the winner.
 *   - 0 → offerer wins
 *   - 1 → challenger wins
 *
 * The hex string is the exact byte that drove the decision, so the audit log
 * reflects what the server saw at decision time.
 */
export function drawFlip(): FlipDraw {
  const buf = randomBytes(1);
  const hex = buf.toString('hex');
  return { challengerWins: (buf[0] & 1) === 1, hex };
}
