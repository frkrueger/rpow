/** 1 RPOW expressed in base units (10^9). */
export const BASE_UNITS_PER_RPOW = 1_000_000_000n;

/** Generate a zero-padded 6-digit numeric code, e.g. "034281". */
export function generateCode(): string {
  const n = Math.floor(Math.random() * 1_000_000);
  return String(n).padStart(6, '0');
}

/**
 * Ticket count earned by a successfully-verified entry.
 *   1 base ticket; +1 extra if balance ≥ 1 RPOW at verify time.
 */
export function ticketCountForBalance(balanceBaseUnits: bigint): 1 | 2 {
  return balanceBaseUnits >= BASE_UNITS_PER_RPOW ? 2 : 1;
}

/** Canonical tweet text for the daily entry. */
export function tweetTemplate(code: string): string {
  return `I am entering the daily free lottery for 1000 RPOW. My code is ${code}. freelottery.rpow2.com`;
}

/** Twitter intent URL pre-filled with the tweet template. */
export function tweetIntentUrl(code: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetTemplate(code))}`;
}
