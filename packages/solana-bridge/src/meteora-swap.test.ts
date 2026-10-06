import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import { MeteoraClient } from './meteora-swap.js';

const SRPOW = new PublicKey('8HBryhguUBG7APYAKAANiEMCw6zo1UYP7Xuj1ndvcPJH');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const POOL = new PublicKey('DaZaVFzob8SbEoNxn9nDWBEWnykigm4Jtdrc1cQM7qt3');
const BLOCKHASH = '11111111111111111111111111111111';

function poolState() {
  return {
    tokenAMint: SRPOW, tokenBMint: USDC,
    tokenAVault: Keypair.generate().publicKey, tokenBVault: Keypair.generate().publicKey,
    tokenAFlag: 0, tokenBFlag: 0,
  };
}

function makeClient(overrides: Partial<{ cpAmm: any; conn: any }> = {}) {
  const bridge = Keypair.generate();
  const cpAmm = overrides.cpAmm ?? {
    fetchPoolState: vi.fn().mockResolvedValue(poolState()),
    getQuote: vi.fn().mockReturnValue({ swapOutAmount: new BN(4707), minSwapOutAmount: new BN(4702) }),
    swap: vi.fn().mockImplementation(async () => {
      const tx = new Transaction();
      tx.add(SystemProgram.transfer({ fromPubkey: bridge.publicKey, toPubkey: USDC, lamports: 1 }));
      return tx;
    }),
  };
  const conn = overrides.conn ?? {
    getSlot: vi.fn().mockResolvedValue(100),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: BLOCKHASH, lastValidBlockHeight: 200 }),
    sendRawTransaction: vi.fn().mockResolvedValue('SUBMITTED'),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
  };
  const client = new MeteoraClient({
    connection: conn, bridge, pool: POOL, commitment: 'finalized', timeoutMs: 30_000, cpAmm,
  });
  return { client, cpAmm, conn, bridge };
}

describe('MeteoraClient.swap', () => {
  it('quotes, builds, signs, sends and confirms; reports the USDC out amount', async () => {
    const { client, cpAmm, conn } = makeClient();
    let prepared: string | null = null;
    const r = await client.swap({
      inputMint: SRPOW.toBase58(), amountBaseUnits: 5_000_000_000n, maxSlippageBps: 1000,
      onSignaturePrepared: async (sig) => { prepared = sig; },
    });
    expect(r.status).toBe('confirmed');
    if (r.status === 'confirmed') {
      expect(r.signature).toBe(prepared);
      expect(r.outputMint).toBe(USDC.toBase58());
      expect(r.out_amount).toBe(4707n);
    }
    // Quote uses the caller's slippage cap and the pool's other side as output.
    const q = cpAmm.getQuote.mock.calls[0][0];
    expect(q.slippage).toBe(1000);
    expect(q.inAmount.toString()).toBe('5000000000');
    const s = cpAmm.swap.mock.calls[0][0];
    expect(s.outputTokenMint.toBase58()).toBe(USDC.toBase58());
    expect(s.minimumAmountOut.toString()).toBe('4702');
    // persist-before-submit: onSignaturePrepared ran before sendRawTransaction
    expect(prepared).not.toBeNull();
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns failed with no signature when the pool state cannot be fetched', async () => {
    const { client } = makeClient({ cpAmm: { fetchPoolState: vi.fn().mockRejectedValue(new Error('rpc down')) } });
    const r = await client.swap({
      inputMint: SRPOW.toBase58(), amountBaseUnits: 1n, maxSlippageBps: 1000,
      onSignaturePrepared: async () => { throw new Error('must not be called'); },
    });
    expect(r).toEqual({ status: 'failed', signature: null, failureReason: 'rpc down' });
  });

  it('returns failed when the input mint is not in the pool', async () => {
    const { client } = makeClient();
    const r = await client.swap({
      inputMint: Keypair.generate().publicKey.toBase58(), amountBaseUnits: 1n, maxSlippageBps: 1000,
      onSignaturePrepared: async () => {},
    });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failureReason).toMatch(/not in pool/);
  });

  it('returns failed with the signature when confirmation reports an error', async () => {
    const { client } = makeClient({ conn: {
      getSlot: vi.fn().mockResolvedValue(100),
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: BLOCKHASH, lastValidBlockHeight: 200 }),
      sendRawTransaction: vi.fn().mockResolvedValue('SUBMITTED'),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: { InstructionError: [0, 'Custom'] } } }),
    } });
    const r = await client.swap({
      inputMint: SRPOW.toBase58(), amountBaseUnits: 1n, maxSlippageBps: 1000, onSignaturePrepared: async () => {},
    });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') { expect(r.signature).not.toBeNull(); expect(r.failureReason).toMatch(/confirmation err/); }
  });
});
