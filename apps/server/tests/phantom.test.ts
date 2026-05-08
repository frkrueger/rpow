import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

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
