import { describe, it, expect, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';
import { sealEnvelope, buildLinkMessage } from '../src/amm/wallet-link.js';

async function loginA(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  await ctx.pool.query(`UPDATE users SET amm_terms_accepted_at = now() WHERE email=$1`, [email]);
  return `${SESSION_COOKIE}=${signSession({ email }, 'x'.repeat(32), 3600)}`;
}

function signMessage(kp: Keypair, message: string): string {
  const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
  return bs58.encode(sig);
}

describe('POST /amm/wallet/link-confirm', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('happy path: links the wallet and returns retro_attributed: count 0', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await loginA(ctx, 'a@x.com');
    const kp = Keypair.generate();
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    const payload = { email: 'a@x.com', nonce: 'NONCE1', expiresAt };
    const envelope = sealEnvelope(ctx.config.ammLinkHmacSecret, payload);
    const message = buildLinkMessage(payload);

    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/wallet/link-confirm', headers: { cookie },
      payload: {
        pubkey: kp.publicKey.toBase58(),
        signature_b58: signMessage(kp, message),
        nonce_envelope: envelope,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      linked_pubkey: kp.publicKey.toBase58(),
      retro_attributed: { count: 0, total_base_units: '0' },
    });
    const after = await ctx.pool.query(`SELECT solana_pubkey FROM users WHERE email='a@x.com'`);
    expect(after.rows[0].solana_pubkey).toBe(kp.publicKey.toBase58());
  });

  it('retro-attributes prior unattributed deposits from the same pubkey', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await loginA(ctx, 'a@x.com');
    const kp = Keypair.generate();
    // Indexer-style: two unattributed rows sitting around.
    await ctx.pool.query(`
      INSERT INTO usdc_unattributed_deposits(amount_base_units, solana_signature, sender_pubkey)
      VALUES (10000000, 'SIG_PRIOR_1', $1), (5000000, 'SIG_PRIOR_2', $1)
    `, [kp.publicKey.toBase58()]);

    const expiresAt = new Date(Date.now() + 60000).toISOString();
    const payload = { email: 'a@x.com', nonce: 'NONCE1', expiresAt };
    const envelope = sealEnvelope(ctx.config.ammLinkHmacSecret, payload);
    const message = buildLinkMessage(payload);

    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/wallet/link-confirm', headers: { cookie },
      payload: {
        pubkey: kp.publicKey.toBase58(),
        signature_b58: signMessage(kp, message),
        nonce_envelope: envelope,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().retro_attributed).toEqual({ count: 2, total_base_units: '15000000' });

    // 1. Promoted into usdc_deposits with same signatures
    const deps = await ctx.pool.query<{ solana_signature: string }>(
      `SELECT solana_signature FROM usdc_deposits ORDER BY solana_signature`,
    );
    expect(deps.rows.map(r => r.solana_signature)).toEqual(['SIG_PRIOR_1', 'SIG_PRIOR_2']);

    // 2. Unattributed rows marked as claimed (preserved, not deleted)
    const un = await ctx.pool.query<{ claimed_by_email: string | null }>(
      `SELECT claimed_by_email FROM usdc_unattributed_deposits ORDER BY solana_signature`,
    );
    expect(un.rows.every(r => r.claimed_by_email === 'a@x.com')).toBe(true);

    // 3. Balance bumped
    const bal = await ctx.pool.query<{ usdc_base_units: string }>(
      `SELECT usdc_base_units::text FROM users WHERE email='a@x.com'`,
    );
    expect(bal.rows[0].usdc_base_units).toBe('15000000');
  });

  it('CHALLENGE_EXPIRED when envelope expiry is in the past', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await loginA(ctx, 'a@x.com');
    const kp = Keypair.generate();
    const payload = { email: 'a@x.com', nonce: 'N', expiresAt: new Date(Date.now() - 1000).toISOString() };
    const envelope = sealEnvelope(ctx.config.ammLinkHmacSecret, payload);
    const message = buildLinkMessage(payload);
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/wallet/link-confirm', headers: { cookie },
      payload: { pubkey: kp.publicKey.toBase58(), signature_b58: signMessage(kp, message), nonce_envelope: envelope },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('CHALLENGE_EXPIRED');
  });

  it('BAD_SIGNATURE when signature is from a different key', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await loginA(ctx, 'a@x.com');
    const kpClaimed = Keypair.generate();
    const kpActual = Keypair.generate();
    const payload = { email: 'a@x.com', nonce: 'N', expiresAt: new Date(Date.now() + 60000).toISOString() };
    const envelope = sealEnvelope(ctx.config.ammLinkHmacSecret, payload);
    const message = buildLinkMessage(payload);
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/wallet/link-confirm', headers: { cookie },
      payload: {
        pubkey: kpClaimed.publicKey.toBase58(),
        signature_b58: signMessage(kpActual, message),
        nonce_envelope: envelope,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_SIGNATURE');
  });

  it('ALREADY_LINKED when user already has a solana_pubkey set', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await loginA(ctx, 'a@x.com');
    await ctx.pool.query(`UPDATE users SET solana_pubkey='OLDPK' WHERE email='a@x.com'`);
    const kp = Keypair.generate();
    const payload = { email: 'a@x.com', nonce: 'N', expiresAt: new Date(Date.now() + 60000).toISOString() };
    const envelope = sealEnvelope(ctx.config.ammLinkHmacSecret, payload);
    const message = buildLinkMessage(payload);
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/wallet/link-confirm', headers: { cookie },
      payload: { pubkey: kp.publicKey.toBase58(), signature_b58: signMessage(kp, message), nonce_envelope: envelope },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('ALREADY_LINKED');
  });

  it('PUBKEY_IN_USE when another email already linked the same pubkey', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await loginA(ctx, 'a@x.com');
    const kp = Keypair.generate();
    await ctx.pool.query(`INSERT INTO users(email, solana_pubkey) VALUES ('other@x.com', $1)`, [kp.publicKey.toBase58()]);
    const payload = { email: 'a@x.com', nonce: 'N', expiresAt: new Date(Date.now() + 60000).toISOString() };
    const envelope = sealEnvelope(ctx.config.ammLinkHmacSecret, payload);
    const message = buildLinkMessage(payload);
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/wallet/link-confirm', headers: { cookie },
      payload: { pubkey: kp.publicKey.toBase58(), signature_b58: signMessage(kp, message), nonce_envelope: envelope },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('PUBKEY_IN_USE');
  });
});
