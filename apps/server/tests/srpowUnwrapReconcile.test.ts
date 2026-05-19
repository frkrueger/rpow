import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { reconcilePendingUnwraps } from '../src/srpow-unwrap-reconcile.js';

// Use 88-char realistic sigs.
const SIG_PEND = 'p'.repeat(88);
const SIG_FAIL = 'f'.repeat(88);
const SIG_INB = 'i'.repeat(88);
const SIG_SWAP = 's'.repeat(88);
const SIG_BURN = 'b'.repeat(88);

describe('reconcilePendingUnwraps', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('leaves an inbound-sig-pending row alone', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('u@x','PK')`);
    await ctx.pool.query(
      `INSERT INTO srpow_wrap_events(id,user_email,solana_wallet,amount,direction,status,idempotency_key,solana_signature)
       VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','u@x','PK',100,'UNWRAP','PENDING','idem-rec-k1',$1)`,
      [SIG_PEND],
    );
    ctx.bridgeClient.setSignatureStatus(SIG_PEND, 'pending');
    await reconcilePendingUnwraps(ctx.pool, ctx.bridgeClient, {
      signingPrivateKeyHex: ctx.config.signingPrivateKeyHex,
      srpowUnwrapFeeBps: 500,
    });
    const { rows } = await ctx.pool.query(`SELECT status FROM srpow_wrap_events`);
    expect(rows[0].status).toBe('PENDING');
  });

  it('marks FAILED when inbound sig was failed/not_found', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('u@x','PK')`);
    await ctx.pool.query(
      `INSERT INTO srpow_wrap_events(id,user_email,solana_wallet,amount,direction,status,idempotency_key,solana_signature)
       VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','u@x','PK',100,'UNWRAP','PENDING','idem-rec-k2',$1)`,
      [SIG_FAIL],
    );
    ctx.bridgeClient.setSignatureStatus(SIG_FAIL, 'not_found');
    await reconcilePendingUnwraps(ctx.pool, ctx.bridgeClient, {
      signingPrivateKeyHex: ctx.config.signingPrivateKeyHex,
      srpowUnwrapFeeBps: 500,
    });
    const { rows } = await ctx.pool.query(`SELECT status FROM srpow_wrap_events`);
    expect(rows[0].status).toBe('FAILED');
  });

  it('credits the user when burn_signature is set + confirmed but no credit token exists', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('u@x','PK')`);
    await ctx.pool.query(
      `INSERT INTO srpow_wrap_events(id,user_email,solana_wallet,amount,direction,status,idempotency_key,
         solana_signature,swap_signature,burn_signature)
       VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc','u@x','PK',100000000000,'UNWRAP','PENDING','idem-rec-k3',$1,$2,$3)`,
      [SIG_INB, SIG_SWAP, SIG_BURN],
    );
    ctx.bridgeClient.setSignatureStatus(SIG_INB, 'confirmed');
    ctx.bridgeClient.setSignatureStatus(SIG_SWAP, 'confirmed');
    ctx.bridgeClient.setSignatureStatus(SIG_BURN, 'confirmed');
    await reconcilePendingUnwraps(ctx.pool, ctx.bridgeClient, {
      signingPrivateKeyHex: ctx.config.signingPrivateKeyHex,
      srpowUnwrapFeeBps: 500,
    });
    const { rows: ev } = await ctx.pool.query(`SELECT status FROM srpow_wrap_events`);
    expect(ev[0].status).toBe('CONFIRMED');
    const { rows: t } = await ctx.pool.query(`SELECT value::text AS value FROM tokens WHERE owner_email='u@x'`);
    expect(t[0].value).toBe('95000000000');
  });
});
