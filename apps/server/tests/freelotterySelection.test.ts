import { describe, it, expect } from 'vitest';
import { pickWinner, type Entry } from '../src/freelottery/selection.js';

const E = (email: string, tickets: 1 | 2, verifiedAt: string): Entry => ({
  account_email: email,
  ticket_count: tickets,
  verified_at: verifiedAt,
});

describe('pickWinner', () => {
  it('returns null when there are no entries', () => {
    expect(pickWinner([], 'deadbeef')).toBeNull();
  });

  it('returns the only entry when there is exactly one', () => {
    const [only] = [E('a@b', 1, '2026-05-13T10:00:00Z')];
    expect(pickWinner([only], 'deadbeef')).toEqual(only);
  });

  it('is deterministic for fixed inputs', () => {
    const entries = [E('a@b', 1, '2026-05-13T10:00:00Z'), E('c@d', 2, '2026-05-13T11:00:00Z')];
    const w1 = pickWinner(entries, 'GfDfgkABCDEFghijklmnopqrstuvwxyz0123456789ab');
    const w2 = pickWinner(entries, 'GfDfgkABCDEFghijklmnopqrstuvwxyz0123456789ab');
    expect(w1).toEqual(w2);
  });

  it('different blockhashes can pick different winners', () => {
    const entries = [
      E('a@b', 1, '2026-05-13T10:00:00Z'),
      E('c@d', 1, '2026-05-13T11:00:00Z'),
      E('e@f', 1, '2026-05-13T12:00:00Z'),
    ];
    const seen = new Set<string>();
    for (const seed of ['0'.repeat(64), '1'.repeat(64), 'f'.repeat(64), 'a'.repeat(64)]) {
      const w = pickWinner(entries, seed);
      if (w) seen.add(w.account_email);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('weights by ticket_count — an entry with 2 tickets is twice as likely', () => {
    const entries = [E('a@b', 1, '2026-05-13T10:00:00Z'), E('c@d', 2, '2026-05-13T11:00:00Z')];
    // 3 total tickets. Try many seeds and verify c@d wins roughly 2/3 of the time.
    let aWins = 0, cWins = 0;
    for (let i = 0; i < 600; i++) {
      const seed = i.toString(16).padStart(64, '0');
      const w = pickWinner(entries, seed);
      if (w?.account_email === 'a@b') aWins++;
      else if (w?.account_email === 'c@d') cWins++;
    }
    // Deterministic: seeds 0,3,6,...,597 → mod 0 → a; 1,4,7,...,598 → mod 1 → c; 2,5,8,...,599 → mod 2 → c.
    expect(aWins).toBe(200);
    expect(cWins).toBe(400);
  });

  it('sort order is stable: (verified_at ASC, account_email ASC)', () => {
    const entries = [
      E('z@b', 1, '2026-05-13T12:00:00Z'),
      E('a@b', 1, '2026-05-13T10:00:00Z'),
      E('m@b', 1, '2026-05-13T11:00:00Z'),
    ];
    // With ticket index 0 → first verifier (a@b), 1 → m@b, 2 → z@b.
    // Use a hex seed whose first 8 bytes mod 3 = 0.
    const seedZero = '0'.repeat(16) + '0'.repeat(48);
    expect(pickWinner(entries, seedZero)?.account_email).toBe('a@b');
  });
});
