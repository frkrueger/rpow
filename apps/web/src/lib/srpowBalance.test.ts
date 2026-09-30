import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchSrpowBalanceBaseUnits } from './srpowBalance.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('fetchSrpowBalanceBaseUnits', () => {
  it("returns 0n when user has no SRPOW ATA", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: [] } }),
    }) as any;
    const b = await fetchSrpowBalanceBaseUnits({
      rpcUrl: 'https://r', ownerPubkey: 'OWN', mintPubkey: 'MINT',
    });
    expect(b).toBe(0n);
  });

  it('sums all token accounts for the mint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: {
        value: [
          { account: { data: { parsed: { info: { tokenAmount: { amount: '100' } } } } } },
          { account: { data: { parsed: { info: { tokenAmount: { amount: '50' } } } } } },
        ],
      }}),
    }) as any;
    const b = await fetchSrpowBalanceBaseUnits({
      rpcUrl: 'https://r', ownerPubkey: 'OWN', mintPubkey: 'MINT',
    });
    expect(b).toBe(150n);
  });
});
