import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchJupiterQuote, JupiterClient } from './jupiter-swap.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

describe('fetchJupiterQuote', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); globalThis.fetch = fetchMock as any; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns parsed quote on success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        inputMint: 'SRPOW', outputMint: SOL_MINT,
        inAmount: '50', outAmount: '1234', slippageBps: 50,
        priceImpactPct: '0.012',
      }),
    });
    const q = await fetchJupiterQuote({
      apiBase: 'https://j', inputMint: 'SRPOW', outputMint: SOL_MINT,
      amountBaseUnits: 50n, slippageBps: 1000,
    });
    expect(q.inAmount).toBe('50');
    expect(q.outAmount).toBe('1234');
  });

  it('throws when API returns non-ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'down' });
    await expect(fetchJupiterQuote({
      apiBase: 'https://j', inputMint: 'SRPOW', outputMint: SOL_MINT,
      amountBaseUnits: 50n, slippageBps: 1000,
    })).rejects.toThrow(/jupiter quote failed: 500/);
  });
});

describe('JupiterClient.swap (integration with stubbed fetch + connection)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); globalThis.fetch = fetchMock as any; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns slippage_exceeded when quote priceImpactPct > cap', async () => {
    // priceImpactPct is a string like '0.15' meaning 15%.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        inputMint: 'SRPOW', outputMint: SOL_MINT,
        inAmount: '50', outAmount: '40', slippageBps: 50, priceImpactPct: '0.15',
      }),
    });
    const conn: any = {};
    const bridge: any = { publicKey: { toBase58: () => 'BRIDGE_PK' } };
    const r = await new JupiterClient({
      apiBase: 'https://j', connection: conn, bridge, commitment: 'finalized', timeoutMs: 30000,
    }).swap({
      inputMint: 'SRPOW', outputMint: SOL_MINT, amountBaseUnits: 50n, maxSlippageBps: 1000,
      onSignaturePrepared: async () => {},
    });
    expect(r.status).toBe('slippage_exceeded');
  });
});
