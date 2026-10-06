import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { FakeBridgeClient, SolanaBridgeClient } from './bridge-client.js';

const noopCallback = async () => {};

describe('FakeBridgeClient', () => {
  it('mintTo returns the queued signature and records the call', async () => {
    const c = new FakeBridgeClient();
    c.queueResult({ signature: 'fake_sig_1' });
    const r = await c.mintTo(
      { recipientWallet: 'WALLET1', amountBaseUnits: 3_000_000_000n },
      noopCallback,
    );
    expect(r.status).toBe('confirmed');
    expect(r.signature).toBe('fake_sig_1');
    expect(c.calls).toEqual([{ recipientWallet: 'WALLET1', amountBaseUnits: 3_000_000_000n }]);
  });

  it('queues a failure result', async () => {
    const c = new FakeBridgeClient();
    c.queueResult({ error: 'rpc_unavailable' });
    const r = await c.mintTo(
      { recipientWallet: 'WALLET1', amountBaseUnits: 1_000_000_000n },
      noopCallback,
    );
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') throw new Error('expected failed');
    expect(r.failureReason).toBe('rpc_unavailable');
    // Failure path: signature is now non-null so the route can persist it.
    expect(r.signature).toMatch(/^fake_sig_\d+$/);
  });

  it('throws if no result queued', async () => {
    const c = new FakeBridgeClient();
    await expect(
      c.mintTo({ recipientWallet: 'W', amountBaseUnits: 1_000_000_000n }, noopCallback),
    ).rejects.toThrow(/no result queued/);
  });

  it('getSignatureStatus returns queued status', async () => {
    const c = new FakeBridgeClient();
    c.setSignatureStatus('sig_x', 'confirmed');
    expect(await c.getSignatureStatus('sig_x')).toBe('confirmed');
    expect(await c.getSignatureStatus('unknown')).toBe('not_found');
  });

  it('calls onSignaturePrepared before returning the result', async () => {
    const c = new FakeBridgeClient();
    c.queueResult({ signature: 'sig_pre' });
    const sigSeenInCallback: string[] = [];
    const r = await c.mintTo(
      { recipientWallet: 'W', amountBaseUnits: 1n },
      async (sig) => { sigSeenInCallback.push(sig); },
    );
    expect(sigSeenInCallback).toEqual(['sig_pre']);
    expect(r.status).toBe('confirmed');
    if (r.status !== 'confirmed') throw new Error('expected confirmed');
    expect(r.signature).toBe('sig_pre');
  });

  it('returns failed if onSignaturePrepared throws (without consuming queue mismatch)', async () => {
    const c = new FakeBridgeClient();
    c.queueResult({ signature: 'sig_x' });
    const r = await c.mintTo(
      { recipientWallet: 'W', amountBaseUnits: 1n },
      async () => { throw new Error('storage failure'); },
    );
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') throw new Error('expected failed');
    expect(r.signature).toBeNull();
    expect(r.failureReason).toMatch(/storage failure/);
  });
});

describe('FakeBridgeClient.verifyInboundTransfer', () => {
  it('returns queued status for the given sig', async () => {
    const b = new FakeBridgeClient();
    b.queueInboundVerify({ status: 'confirmed' });
    const r = await b.verifyInboundTransfer({
      signature: 'SIG1', expectedFrom: 'A', expectedTo: 'B',
      expectedAmount: 100n, mint: 'M',
    });
    expect(r.status).toBe('confirmed');
  });
  it('throws if no result queued', async () => {
    const b = new FakeBridgeClient();
    await expect(b.verifyInboundTransfer({
      signature: 'SIG1', expectedFrom: 'A', expectedTo: 'B', expectedAmount: 100n, mint: 'M',
    })).rejects.toThrow(/no inbound verify queued/);
  });
});

describe('FakeBridgeClient.swapSrpowForSol', () => {
  it('returns confirmed swap with SOL received', async () => {
    const b = new FakeBridgeClient();
    b.queueSwapResult({ status: 'confirmed', signature: 'SWAP_SIG', sol_received_lamports: 12345n });
    let prepared: string | null = null;
    const r = await b.swapSrpowForSol(50n, 1000, async (sig) => { prepared = sig; });
    expect(r.status).toBe('confirmed');
    expect(prepared).toBe('SWAP_SIG');
    if (r.status === 'confirmed') {
      expect(r.sol_received_lamports).toBe(12345n);
    }
  });

  it('throws if no result queued', async () => {
    const b = new FakeBridgeClient();
    await expect(b.swapSrpowForSol(50n, 1000, async () => {})).rejects.toThrow(/no swap result queued/);
  });

  it('returns failed when onSignaturePrepared throws', async () => {
    const b = new FakeBridgeClient();
    b.queueSwapResult({ status: 'confirmed', signature: 'SWAP_SIG', sol_received_lamports: 1n });
    const r = await b.swapSrpowForSol(50n, 1000, async () => { throw new Error('db down'); });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.signature).toBeNull();
      expect(r.failureReason).toMatch(/db down/);
    }
  });
});

describe('FakeBridgeClient.burnSrpow', () => {
  it('returns confirmed burn and calls onSignaturePrepared', async () => {
    const b = new FakeBridgeClient();
    b.queueBurnResult({ status: 'confirmed', signature: 'BURN_SIG' });
    let prepared: string | null = null;
    const r = await b.burnSrpow(95n, async (sig) => { prepared = sig; });
    expect(r.status).toBe('confirmed');
    expect(prepared).toBe('BURN_SIG');
  });

  it('throws if no result queued', async () => {
    const b = new FakeBridgeClient();
    await expect(b.burnSrpow(95n, async () => {})).rejects.toThrow(/no burn result queued/);
  });

  it('returns failed when onSignaturePrepared throws', async () => {
    const b = new FakeBridgeClient();
    b.queueBurnResult({ status: 'confirmed', signature: 'BURN_SIG' });
    const r = await b.burnSrpow(95n, async () => { throw new Error('db down'); });
    expect(r.status).toBe('failed');
  });
});

describe('FakeBridgeClient.transferSrpowFromBridge', () => {
  it('reuses the mintTo result queue for the refund path', async () => {
    const b = new FakeBridgeClient();
    b.queueResult({ signature: 'REFUND_SIG' });
    let prepared: string | null = null;
    const r = await b.transferSrpowFromBridge('USER_WALLET', 100n, async (sig) => { prepared = sig; });
    expect(r.status).toBe('confirmed');
    expect(prepared).toBe('REFUND_SIG');
  });
});

describe('SolanaBridgeClient.swapSrpowForSol fallback orchestration', () => {
  const SRPOW = new PublicKey('8HBryhguUBG7APYAKAANiEMCw6zo1UYP7Xuj1ndvcPJH');
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const SOL = 'So11111111111111111111111111111111111111112';

  function make(opts: { jupiter: any; meteora?: any }) {
    return new SolanaBridgeClient({
      connection: {} as any, bridge: Keypair.generate(), mint: SRPOW, commitment: 'finalized',
      baseUnitsPerToken: 10n ** 9n, timeoutMs: 1000, jupiterApiBase: 'https://j',
      meteoraPool: opts.meteora ? new PublicKey('DaZaVFzob8SbEoNxn9nDWBEWnykigm4Jtdrc1cQM7qt3') : undefined,
      jupiterClient: opts.jupiter, meteoraClient: opts.meteora,
    });
  }

  it('uses Jupiter directly when it can route SRPOW -> SOL', async () => {
    const jupiter = { swap: vi.fn().mockResolvedValue({ status: 'confirmed', signature: 'J1', sol_received_lamports: 10n }) };
    const meteora = { swap: vi.fn() };
    const r = await make({ jupiter, meteora }).swapSrpowForSol(50n, 1000, async () => {});
    expect(r).toEqual({ status: 'confirmed', signature: 'J1', sol_received_lamports: 10n });
    expect(meteora.swap).not.toHaveBeenCalled();
  });

  it('falls back to Meteora SRPOW -> USDC then Jupiter USDC -> SOL when Jupiter cannot quote SRPOW', async () => {
    const jupiter = { swap: vi.fn()
      .mockResolvedValueOnce({ status: 'quote_failed', failureReason: 'TOKEN_NOT_TRADABLE' })
      .mockResolvedValueOnce({ status: 'confirmed', signature: 'J2', sol_received_lamports: 39136n }) };
    const meteora = { swap: vi.fn().mockImplementation(async (a: any) => {
      await a.onSignaturePrepared('M1');
      return { status: 'confirmed', signature: 'M1', outputMint: USDC, out_amount: 4707n };
    }) };
    const prepared: string[] = [];
    const r = await make({ jupiter, meteora }).swapSrpowForSol(50n, 1000, async (s) => { prepared.push(s); });
    expect(r).toEqual({ status: 'confirmed', signature: 'M1', sol_received_lamports: 39136n });
    // The persisted swap_signature is the leg that spent the SRPOW.
    expect(prepared).toEqual(['M1']);
    expect(meteora.swap.mock.calls[0][0]).toMatchObject({ inputMint: SRPOW.toBase58(), amountBaseUnits: 50n, maxSlippageBps: 1000 });
    expect(jupiter.swap.mock.calls[1][0]).toMatchObject({ inputMint: USDC, outputMint: SOL, amountBaseUnits: 4707n });
  });

  it('still reports confirmed when the USDC -> SOL leg fails (value already captured as USDC)', async () => {
    const jupiter = { swap: vi.fn()
      .mockResolvedValueOnce({ status: 'quote_failed', failureReason: 'TOKEN_NOT_TRADABLE' })
      .mockResolvedValueOnce({ status: 'failed', signature: null, failureReason: 'jupiter down' }) };
    const meteora = { swap: vi.fn().mockResolvedValue({ status: 'confirmed', signature: 'M1', outputMint: USDC, out_amount: 4707n }) };
    const r = await make({ jupiter, meteora }).swapSrpowForSol(50n, 1000, async () => {});
    expect(r).toEqual({ status: 'confirmed', signature: 'M1', sol_received_lamports: 0n });
  });

  it('surfaces a Meteora failure as failed so the route refunds', async () => {
    const jupiter = { swap: vi.fn().mockResolvedValueOnce({ status: 'quote_failed', failureReason: 'TOKEN_NOT_TRADABLE' }) };
    const meteora = { swap: vi.fn().mockResolvedValue({ status: 'failed', signature: null, failureReason: 'pool gone' }) };
    const r = await make({ jupiter, meteora }).swapSrpowForSol(50n, 1000, async () => {});
    expect(r).toEqual({ status: 'failed', signature: null, failureReason: 'pool gone' });
  });

  it('maps quote_failed to failed when no Meteora pool is configured', async () => {
    const jupiter = { swap: vi.fn().mockResolvedValueOnce({ status: 'quote_failed', failureReason: 'TOKEN_NOT_TRADABLE' }) };
    const r = await make({ jupiter }).swapSrpowForSol(50n, 1000, async () => {});
    expect(r).toEqual({ status: 'failed', signature: null, failureReason: 'TOKEN_NOT_TRADABLE' });
  });
});
