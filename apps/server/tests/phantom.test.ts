import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

let cleanup: () => Promise<void> = async () => {};
afterEach(() => cleanup());

describe('POST /phantom/challenge', () => {
  it('issues a nonce + message tied to the user', async () => {
    const t = await makeTestApp();
    cleanup = t.cleanup;
    await t.pool.query(`INSERT INTO users(email) VALUES('alice@x.io')`);
    const session = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);

    const r = await t.app.inject({
      method: 'POST', url: '/phantom/challenge',
      cookies: { [SESSION_COOKIE]: session },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json() as { nonce: string; message: string; expires_at: string };
    expect(body.nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.message).toBe(`rpow2.com bind: ${body.nonce}`);

    const dbRow = await t.pool.query(
      'SELECT user_email, expires_at, used_at FROM phantom_challenges WHERE nonce=$1',
      [body.nonce],
    );
    expect(dbRow.rows[0].user_email).toBe('alice@x.io');
    expect(dbRow.rows[0].used_at).toBeNull();
  });

  it('requires session', async () => {
    const t = await makeTestApp();
    cleanup = t.cleanup;
    const r = await t.app.inject({ method: 'POST', url: '/phantom/challenge' });
    expect(r.statusCode).toBe(401);
  });
});

describe('POST /phantom/bind', () => {
  async function setup() {
    const t = await makeTestApp();
    cleanup = t.cleanup;
    await t.pool.query(`INSERT INTO users(email) VALUES('alice@x.io')`);
    const session = signSession({ email: 'alice@x.io' }, 'x'.repeat(32), 60);
    const ch = await t.app.inject({
      method: 'POST', url: '/phantom/challenge',
      cookies: { [SESSION_COOKIE]: session },
    });
    const { nonce, message } = ch.json() as { nonce: string; message: string };
    return { t, session, nonce, message };
  }

  it('binds the wallet on a valid signature', async () => {
    const { t, session, nonce, message } = await setup();
    const kp = nacl.sign.keyPair();
    const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);

    const r = await t.app.inject({
      method: 'POST', url: '/phantom/bind',
      cookies: { [SESSION_COOKIE]: session },
      payload: {
        nonce,
        wallet_address: bs58.encode(kp.publicKey),
        signature_base58: bs58.encode(sig),
      },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, solana_wallet: bs58.encode(kp.publicKey) });
    const u = await t.pool.query('SELECT solana_wallet FROM users WHERE email=$1', ['alice@x.io']);
    expect(u.rows[0].solana_wallet).toBe(bs58.encode(kp.publicKey));
  });

  it('rejects bad signature', async () => {
    const { t, session, nonce, message } = await setup();
    const kp = nacl.sign.keyPair();
    const tamperedMsg = message + 'x';
    const sig = nacl.sign.detached(new TextEncoder().encode(tamperedMsg), kp.secretKey);

    const r = await t.app.inject({
      method: 'POST', url: '/phantom/bind',
      cookies: { [SESSION_COOKIE]: session },
      payload: { nonce, wallet_address: bs58.encode(kp.publicKey), signature_base58: bs58.encode(sig) },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('BAD_SIGNATURE');
  });

  it('idempotent rebind of the same wallet', async () => {
    const { t, session, nonce, message } = await setup();
    const kp = nacl.sign.keyPair();
    const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
    const payload = { nonce, wallet_address: bs58.encode(kp.publicKey), signature_base58: bs58.encode(sig) };

    const a = await t.app.inject({ method: 'POST', url: '/phantom/bind', cookies: { [SESSION_COOKIE]: session }, payload });
    expect(a.statusCode).toBe(200);
    const b = await t.app.inject({ method: 'POST', url: '/phantom/bind', cookies: { [SESSION_COOKIE]: session }, payload });
    expect(b.statusCode).toBe(200);             // idempotent: same wallet rebind = no-op success
    expect(b.json().solana_wallet).toBe(bs58.encode(kp.publicKey));
  });

  it('rejects a nonce that has already been used', async () => {
    const { t, session, nonce, message } = await setup();
    const kp = nacl.sign.keyPair();
    const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
    const payload = { nonce, wallet_address: bs58.encode(kp.publicKey), signature_base58: bs58.encode(sig) };

    const a = await t.app.inject({ method: 'POST', url: '/phantom/bind', cookies: { [SESSION_COOKIE]: session }, payload });
    expect(a.statusCode).toBe(200);

    // Replay the same nonce with a DIFFERENT wallet — should now reject.
    const otherKp = nacl.sign.keyPair();
    const otherSig = nacl.sign.detached(new TextEncoder().encode(message), otherKp.secretKey);
    const r = await t.app.inject({
      method: 'POST', url: '/phantom/bind', cookies: { [SESSION_COOKIE]: session },
      payload: { nonce, wallet_address: bs58.encode(otherKp.publicKey), signature_base58: bs58.encode(otherSig) },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('NONCE_INVALID');
  });

  it('rejects WALLET_TAKEN when a different user already bound the same wallet', async () => {
    const { t, session: aliceSession, nonce, message } = await setup();
    const kp = nacl.sign.keyPair();
    const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
    await t.app.inject({
      method: 'POST', url: '/phantom/bind',
      cookies: { [SESSION_COOKIE]: aliceSession },
      payload: { nonce, wallet_address: bs58.encode(kp.publicKey), signature_base58: bs58.encode(sig) },
    });

    // bob attempts to bind alice's wallet
    await t.pool.query(`INSERT INTO users(email) VALUES('bob@x.io')`);
    const bobSession = signSession({ email: 'bob@x.io' }, 'x'.repeat(32), 60);
    const ch = await t.app.inject({
      method: 'POST', url: '/phantom/challenge', cookies: { [SESSION_COOKIE]: bobSession },
    });
    const bobNonce = (ch.json() as any).nonce as string;
    const bobMsg = `rpow2.com bind: ${bobNonce}`;
    const bobSig = nacl.sign.detached(new TextEncoder().encode(bobMsg), kp.secretKey);

    const r = await t.app.inject({
      method: 'POST', url: '/phantom/bind', cookies: { [SESSION_COOKIE]: bobSession },
      payload: { nonce: bobNonce, wallet_address: bs58.encode(kp.publicKey), signature_base58: bs58.encode(bobSig) },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('WALLET_TAKEN');
  });
});
