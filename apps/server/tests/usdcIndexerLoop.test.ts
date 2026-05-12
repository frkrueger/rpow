import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { tick, loadCursor } from '../src/amm/usdc-indexer.js';

const AMM_ATA = '9wVgJE1iKnBS8FiSnHc7jXv5Lz6uD819UYxwu7QAxxSp';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function makeRpc(sigs: any[], parsed: Record<string, any>) {
  return {
    getSignaturesForAddress: async () => sigs,
    getParsedTransaction: async (sig: string) => parsed[sig] ?? null,
  };
}

function txTransfer(authority: string, amount: string): any {
  return {
    transaction: { message: { instructions: [
      { program: 'spl-token', parsed: { type: 'transferChecked',
        info: { source: 'S', destination: AMM_ATA, authority, mint: USDC, tokenAmount: { amount } } } },
    ] } },
    meta: { innerInstructions: [] },
    blockTime: 1715000000,
  };
}

describe('tick()', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('processes a single attributed deposit, advances cursor', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_pubkey) VALUES ('a@x.com', 'PK1')`);
    const rpc = makeRpc(
      [{ signature: 'NEW1', err: null, blockTime: 1715000000 }],
      { NEW1: txTransfer('PK1', '500') },
    );
    await tick({
      pool: ctx.pool, rpc, ammAta: AMM_ATA, usdcMint: USDC,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
      bootstrapLimit: 10,
    });
    const bal = await ctx.pool.query<{ b: string }>(`SELECT usdc_base_units::text AS b FROM users WHERE email='a@x.com'`);
    expect(bal.rows[0].b).toBe('500');
    expect(await loadCursor(ctx.pool)).toBe('NEW1');
  });

  it('processes oldest-first (RPC returns newest-first)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_pubkey) VALUES ('a@x.com', 'PK1')`);
    const rpc = makeRpc(
      // RPC convention: newest first
      [
        { signature: 'NEW3', err: null, blockTime: 3 },
        { signature: 'NEW2', err: null, blockTime: 2 },
        { signature: 'NEW1', err: null, blockTime: 1 },
      ],
      { NEW1: txTransfer('PK1', '1'), NEW2: txTransfer('PK1', '10'), NEW3: txTransfer('PK1', '100') },
    );
    await tick({ pool: ctx.pool, rpc, ammAta: AMM_ATA, usdcMint: USDC,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
      bootstrapLimit: 10,
    });
    // Cursor should be the newest sig
    expect(await loadCursor(ctx.pool)).toBe('NEW3');
    // All three credited
    const bal = await ctx.pool.query<{ b: string }>(`SELECT usdc_base_units::text AS b FROM users WHERE email='a@x.com'`);
    expect(bal.rows[0].b).toBe('111');
  });

  it('skips failed transactions', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_pubkey) VALUES ('a@x.com', 'PK1')`);
    const rpc = makeRpc(
      [{ signature: 'NEW1', err: { something: 'oops' }, blockTime: 1 }],
      { NEW1: txTransfer('PK1', '999') },
    );
    await tick({ pool: ctx.pool, rpc, ammAta: AMM_ATA, usdcMint: USDC,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
      bootstrapLimit: 10,
    });
    const bal = await ctx.pool.query<{ b: string }>(`SELECT usdc_base_units::text AS b FROM users WHERE email='a@x.com'`);
    expect(bal.rows[0].b).toBe('0');
    // Cursor still advances past the failed tx (we processed it; the skip is the work).
    expect(await loadCursor(ctx.pool)).toBe('NEW1');
  });

  it('on getParsedTransaction returning null, breaks without advancing past the bad sig', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_pubkey) VALUES ('a@x.com', 'PK1')`);
    const rpc = makeRpc(
      // newest first: NEW2 will be processed (oldest after reverse) and succeeds; NEW3 returns null and breaks the loop.
      [{ signature: 'NEW3', err: null, blockTime: 3 }, { signature: 'NEW2', err: null, blockTime: 2 }],
      { NEW2: txTransfer('PK1', '11'), NEW3: null },
    );
    await tick({ pool: ctx.pool, rpc, ammAta: AMM_ATA, usdcMint: USDC,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
      bootstrapLimit: 10,
    });
    // NEW2 was processed successfully, cursor at NEW2; NEW3 not advanced past.
    expect(await loadCursor(ctx.pool)).toBe('NEW2');
    const bal = await ctx.pool.query<{ b: string }>(`SELECT usdc_base_units::text AS b FROM users WHERE email='a@x.com'`);
    expect(bal.rows[0].b).toBe('11');
  });

  it('no new signatures: touches last_run_at but leaves last_signature unchanged', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const rpc = makeRpc([], {});
    await tick({ pool: ctx.pool, rpc, ammAta: AMM_ATA, usdcMint: USDC,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
      bootstrapLimit: 10,
    });
    expect(await loadCursor(ctx.pool)).toBeNull();
  });
});
