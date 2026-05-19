import { describe, it, expect, vi } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { SolanaBridgeClient } from './bridge-client.js';

function makeClient() {
  const conn = {
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 }),
    sendRawTransaction: vi.fn().mockResolvedValue('SIG'),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    getAccountInfo: vi.fn().mockResolvedValue(null),
  } as unknown as Connection;
  return {
    client: new SolanaBridgeClient({
      connection: conn,
      bridge: Keypair.generate(),
      mint: new PublicKey('So11111111111111111111111111111111111111112'),
      commitment: 'finalized',
      baseUnitsPerToken: 10n ** 9n,
      timeoutMs: 30000,
      jupiterApiBase: 'https://quote-api.jup.ag',
    }),
    conn,
  };
}

describe('SolanaBridgeClient.burnSrpow', () => {
  it('builds a burn tx, calls onSignaturePrepared, awaits confirmation', async () => {
    const { client, conn } = makeClient();
    let prepared: string | null = null;
    const r = await client.burnSrpow(95n, async (sig) => { prepared = sig; });
    expect(r.status).toBe('confirmed');
    expect(prepared).not.toBeNull();
    expect((conn.sendRawTransaction as any)).toHaveBeenCalledOnce();
  });

  it('returns failed when confirmTransaction returns err', async () => {
    const { client, conn } = makeClient();
    (conn.confirmTransaction as any).mockResolvedValue({ value: { err: 'InsufficientFunds' } });
    const r = await client.burnSrpow(95n, async () => {});
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failureReason).toMatch(/InsufficientFunds/);
  });
});

describe('SolanaBridgeClient.transferSrpowFromBridge', () => {
  it('builds a transfer tx and returns confirmed', async () => {
    const { client } = makeClient();
    let prepared: string | null = null;
    const r = await client.transferSrpowFromBridge(
      Keypair.generate().publicKey.toBase58(),
      100n,
      async (sig) => { prepared = sig; },
    );
    expect(r.status).toBe('confirmed');
    expect(prepared).not.toBeNull();
  });
});
