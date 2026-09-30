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

  it('completes a swap end-to-end and returns confirmed with sol_received_lamports', async () => {
    // Stub a quote with acceptable slippage.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        inputMint: 'SRPOW', outputMint: SOL_MINT,
        inAmount: '50', outAmount: '1234',
        slippageBps: 50, priceImpactPct: '0.001',
      }),
    });
    // Build a real VersionedTransaction so deserialize() + sign() work.
    // Easiest: use @solana/web3.js to build a no-op tx with a real blockhash.
    const { TransactionMessage, VersionedTransaction, Keypair, PublicKey, SystemProgram } = await import('@solana/web3.js');
    const bridge = Keypair.generate();
    const msg = new TransactionMessage({
      payerKey: bridge.publicKey,
      recentBlockhash: '11111111111111111111111111111111',  // valid 32-byte base58
      instructions: [SystemProgram.transfer({
        fromPubkey: bridge.publicKey,
        toPubkey: new PublicKey('So11111111111111111111111111111111111111112'),
        lamports: 1,
      })],
    }).compileToV0Message();
    const realTx = new VersionedTransaction(msg);
    const swapTxBase64 = Buffer.from(realTx.serialize()).toString('base64');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ swapTransaction: swapTxBase64 }),
    });

    const conn: any = {
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100,
      }),
      sendRawTransaction: vi.fn().mockResolvedValue('SUBMITTED'),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    };

    let prepared: string | null = null;
    const r = await new JupiterClient({
      apiBase: 'https://j', connection: conn, bridge, commitment: 'finalized', timeoutMs: 30000,
    }).swap({
      inputMint: 'SRPOW', outputMint: SOL_MINT, amountBaseUnits: 50n, maxSlippageBps: 1000,
      onSignaturePrepared: async (sig) => { prepared = sig; },
    });

    expect(r.status).toBe('confirmed');
    if (r.status === 'confirmed') {
      expect(r.sol_received_lamports).toBe(1234n);
      expect(r.signature).toBe(prepared);
    }
    // Verify the order: getLatestBlockhash BEFORE sendRawTransaction
    const ghOrder = (conn.getLatestBlockhash as any).mock.invocationCallOrder[0];
    const srOrder = (conn.sendRawTransaction as any).mock.invocationCallOrder[0];
    expect(ghOrder).toBeLessThan(srOrder);
  });
});
