export interface Entry {
  account_email: string;
  ticket_count: 1 | 2;
  verified_at: string; // ISO timestamp
}

/**
 * Deterministically picks a winner from the entry list using the Solana
 * blockhash as the random seed. The first 8 bytes (16 hex chars) of the
 * blockhash are interpreted as a big-endian uint64, then taken modulo the
 * total ticket count to choose a ticket index. Entries are sorted by
 * (verified_at ASC, account_email ASC) and each is expanded by its
 * ticket_count to form the ticket list. Returns null when there are no
 * entries.
 */
export function pickWinner(entries: Entry[], blockhash: string): Entry | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => {
    if (a.verified_at < b.verified_at) return -1;
    if (a.verified_at > b.verified_at) return 1;
    if (a.account_email < b.account_email) return -1;
    if (a.account_email > b.account_email) return 1;
    return 0;
  });
  const tickets: Entry[] = [];
  for (const e of sorted) {
    for (let i = 0; i < e.ticket_count; i++) tickets.push(e);
  }
  const hexOnly = blockhash.replace(/^0x/, '').replace(/[^0-9a-fA-F]/g, '').padEnd(1, '0');
  const seed = BigInt('0x' + hexOnly);
  const idx = Number(seed % BigInt(tickets.length));
  return tickets[idx];
}
