import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function loginAdmin(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  await ctx.pool.query(`UPDATE users SET amm_terms_accepted_at = now() WHERE email=$1`, [email]);
  return `${SESSION_COOKIE}=${signSession({ email }, 'x'.repeat(32), 3600)}`;
}

describe('POST /amm/admin/claim-unattributed', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('NOT_ADMIN when caller isn\'t in AMM_ADMIN_EMAILS', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com' }); cleanup = ctx.cleanup;
    const cookie = await loginAdmin(ctx, 'someoneelse@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/admin/claim-unattributed',
      headers: { cookie },
      payload: { solana_signature: 'SIG1', target_email: 'a@x.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('promotes the unattributed row to usdc_deposits, credits balance, preserves audit row', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com' }); cleanup = ctx.cleanup;
    const cookie = await loginAdmin(ctx, 'admin@x.com');
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x.com')`);
    await ctx.pool.query(`
      INSERT INTO usdc_unattributed_deposits(amount_base_units, solana_signature, sender_pubkey)
      VALUES (7000000, 'SIG1', 'PK1')
    `);

    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/admin/claim-unattributed', headers: { cookie },
      payload: { solana_signature: 'SIG1', target_email: 'a@x.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ credited_email: 'a@x.com', amount_base_units: '7000000' });

    const dep = await ctx.pool.query(`SELECT account_email FROM usdc_deposits WHERE solana_signature='SIG1'`);
    expect(dep.rows[0].account_email).toBe('a@x.com');

    const un = await ctx.pool.query(`SELECT claimed_by_email, claimed_at FROM usdc_unattributed_deposits WHERE solana_signature='SIG1'`);
    expect(un.rows[0].claimed_by_email).toBe('a@x.com');
    expect(un.rows[0].claimed_at).not.toBeNull();

    const bal = await ctx.pool.query<{ usdc_base_units: string }>(`SELECT usdc_base_units::text FROM users WHERE email='a@x.com'`);
    expect(bal.rows[0].usdc_base_units).toBe('7000000');
  });

  it('ALREADY_CLAIMED on second call', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com' }); cleanup = ctx.cleanup;
    const cookie = await loginAdmin(ctx, 'admin@x.com');
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x.com')`);
    await ctx.pool.query(`
      INSERT INTO usdc_unattributed_deposits(amount_base_units, solana_signature, sender_pubkey)
      VALUES (1, 'SIG2', 'PK1')
    `);
    await ctx.app.inject({
      method: 'POST', url: '/amm/admin/claim-unattributed', headers: { cookie },
      payload: { solana_signature: 'SIG2', target_email: 'a@x.com' },
    });
    const second = await ctx.app.inject({
      method: 'POST', url: '/amm/admin/claim-unattributed', headers: { cookie },
      payload: { solana_signature: 'SIG2', target_email: 'a@x.com' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('ALREADY_CLAIMED');
  });

  it('NOT_FOUND when signature not in unattributed table', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com' }); cleanup = ctx.cleanup;
    const cookie = await loginAdmin(ctx, 'admin@x.com');
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x.com')`);
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/admin/claim-unattributed', headers: { cookie },
      payload: { solana_signature: 'NOSUCHSIG', target_email: 'a@x.com' },
    });
    expect(res.statusCode).toBe(404);
  });
});
