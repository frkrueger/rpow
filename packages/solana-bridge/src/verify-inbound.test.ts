import { describe, it, expect, vi } from 'vitest';
import { Connection } from '@solana/web3.js';
import { SolanaBridgeClient } from './bridge-client.js';

function makeClient(opts: {
  getTransactionImpl?: any;
  getSignatureStatusImpl?: any;
}): SolanaBridgeClient {
  // Default: signature is 'confirmed' so the second-stage getTransaction is reached.
  const defaultSigStatus = vi.fn().mockResolvedValue({
    value: { confirmationStatus: 'finalized', err: null },
  });
  const conn = {
    getTransaction: opts.getTransactionImpl ?? vi.fn().mockResolvedValue(null),
    getSignatureStatus: opts.getSignatureStatusImpl ?? defaultSigStatus,
  } as unknown as Connection;
  return new SolanaBridgeClient({
    connection: conn,
    bridge: {} as any,
    mint: { toBase58: () => 'MINT' } as any,
    commitment: 'finalized',
    baseUnitsPerToken: 10n ** 9n,
    timeoutMs: 30000,
    jupiterApiBase: 'https://quote-api.jup.ag',
  });
}

describe('SolanaBridgeClient.verifyInboundTransfer', () => {
  it("returns 'not_found' when signature is unknown to the cluster", async () => {
    const c = makeClient({
      getSignatureStatusImpl: vi.fn().mockResolvedValue({ value: null }),
    });
    const r = await c.verifyInboundTransfer({
      signature: 'SIG', expectedFrom: 'FROM', expectedTo: 'TO',
      expectedAmount: 100n, mint: 'MINT',
    });
    expect(r.status).toBe('not_found');
  });

  it("returns 'failed' when tx has meta.err", async () => {
    const c = makeClient({
      getTransactionImpl: vi.fn().mockResolvedValue({
        meta: { err: { InstructionError: [0, 'Custom'] } },
        transaction: { message: { instructions: [] } },
      }),
    });
    const r = await c.verifyInboundTransfer({
      signature: 'SIG', expectedFrom: 'FROM', expectedTo: 'TO',
      expectedAmount: 100n, mint: 'MINT',
    });
    expect(r.status).toBe('failed');
  });

  it("returns 'mismatch wrong_amount' for an SPL transfer of a different amount", async () => {
    const c = makeClient({
      getTransactionImpl: vi.fn().mockResolvedValue({
        meta: {
          err: null,
          preTokenBalances: [
            { accountIndex: 0, mint: 'MINT', owner: 'FROM', uiTokenAmount: { amount: '1000' } },
            { accountIndex: 1, mint: 'MINT', owner: 'TO',   uiTokenAmount: { amount: '0' } },
          ],
          postTokenBalances: [
            { accountIndex: 0, mint: 'MINT', owner: 'FROM', uiTokenAmount: { amount: '950' } },
            { accountIndex: 1, mint: 'MINT', owner: 'TO',   uiTokenAmount: { amount: '50' } },
          ],
        },
        transaction: { message: { instructions: [] } },
      }),
    });
    const r = await c.verifyInboundTransfer({
      signature: 'SIG', expectedFrom: 'FROM', expectedTo: 'TO',
      expectedAmount: 100n, mint: 'MINT',  // expected 100, observed 50
    });
    expect(r).toEqual({ status: 'mismatch', reason: 'wrong_amount' });
  });

  it("returns 'confirmed' when SPL token balances change by expected amount", async () => {
    const c = makeClient({
      getTransactionImpl: vi.fn().mockResolvedValue({
        meta: {
          err: null,
          preTokenBalances: [
            { accountIndex: 0, mint: 'MINT', owner: 'FROM', uiTokenAmount: { amount: '1000' } },
            { accountIndex: 1, mint: 'MINT', owner: 'TO',   uiTokenAmount: { amount: '0' } },
          ],
          postTokenBalances: [
            { accountIndex: 0, mint: 'MINT', owner: 'FROM', uiTokenAmount: { amount: '900' } },
            { accountIndex: 1, mint: 'MINT', owner: 'TO',   uiTokenAmount: { amount: '100' } },
          ],
        },
        transaction: { message: { instructions: [] } },
      }),
    });
    const r = await c.verifyInboundTransfer({
      signature: 'SIG', expectedFrom: 'FROM', expectedTo: 'TO',
      expectedAmount: 100n, mint: 'MINT',
    });
    expect(r.status).toBe('confirmed');
  });

  it("returns 'pending' when sig is below commitment level", async () => {
    const c = makeClient({
      getSignatureStatusImpl: vi.fn().mockResolvedValue({
        value: { confirmationStatus: 'processed', err: null },
      }),
    });
    const r = await c.verifyInboundTransfer({
      signature: 'SIG', expectedFrom: 'FROM', expectedTo: 'TO',
      expectedAmount: 100n, mint: 'MINT',
    });
    expect(r.status).toBe('pending');
  });

  it("returns 'mismatch wrong_mint' when no post-balance entry is for the expected mint", async () => {
    const c = makeClient({
      getTransactionImpl: vi.fn().mockResolvedValue({
        meta: {
          err: null,
          preTokenBalances: [
            { accountIndex: 0, mint: 'OTHER_MINT', owner: 'FROM', uiTokenAmount: { amount: '1000' } },
            { accountIndex: 1, mint: 'OTHER_MINT', owner: 'TO',   uiTokenAmount: { amount: '0' } },
          ],
          postTokenBalances: [
            { accountIndex: 0, mint: 'OTHER_MINT', owner: 'FROM', uiTokenAmount: { amount: '900' } },
            { accountIndex: 1, mint: 'OTHER_MINT', owner: 'TO',   uiTokenAmount: { amount: '100' } },
          ],
        },
        transaction: { message: { instructions: [] } },
      }),
    });
    const r = await c.verifyInboundTransfer({
      signature: 'SIG', expectedFrom: 'FROM', expectedTo: 'TO',
      expectedAmount: 100n, mint: 'MINT',
    });
    expect(r).toEqual({ status: 'mismatch', reason: 'wrong_mint' });
  });

  it("returns 'mismatch wrong_from' when sender row is missing", async () => {
    const c = makeClient({
      getTransactionImpl: vi.fn().mockResolvedValue({
        meta: {
          err: null,
          preTokenBalances: [
            { accountIndex: 1, mint: 'MINT', owner: 'TO', uiTokenAmount: { amount: '0' } },
          ],
          postTokenBalances: [
            { accountIndex: 1, mint: 'MINT', owner: 'TO', uiTokenAmount: { amount: '100' } },
          ],
        },
        transaction: { message: { instructions: [] } },
      }),
    });
    const r = await c.verifyInboundTransfer({
      signature: 'SIG', expectedFrom: 'FROM', expectedTo: 'TO',
      expectedAmount: 100n, mint: 'MINT',
    });
    expect(r.status).toBe('mismatch');
    if (r.status === 'mismatch') expect(r.reason).toBe('wrong_from');
  });
});
