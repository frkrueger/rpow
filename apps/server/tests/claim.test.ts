import { describe, it, expect, afterEach } from 'vitest';
import { latestTokenFromEmail, loginAs, makeTestApp, mineN } from './helpers.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

async function sendPending(ctx: Awaited<ReturnType<typeof makeTestApp>>, senderCookie: string, recipient: string, amount: number) {
  return ctx.app.inject({
    method: 'POST',
    url: '/send',
    headers: { cookie: senderCookie, 'content-type': 'application/json' },
    payload: { recipient_email: recipient, amount, idempotency_key: randomUUID() },
  });
}

describe('GET /claim', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('claims pending tokens as children without inflating minted supply', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const senderCookie = await loginAs(ctx, 'sender@x.com');
    await mineN(ctx, senderCookie, 2);
    const beforeCounter = await ctx.pool.query<{ value: string }>("SELECT value FROM app_counters WHERE name='minted_supply'");
    const parentIds = (await ctx.pool.query<{ id: string }>(
      "SELECT id FROM tokens WHERE owner_email='sender@x.com' AND state='VALID' ORDER BY issued_at ASC",
    )).rows.map((r) => r.id);

    const send = await sendPending(ctx, senderCookie, 'recipient@x.com', 2);
    expect(send.statusCode).toBe(200);
    const token = latestTokenFromEmail(ctx);
    const claim = await ctx.app.inject({ method: 'GET', url: `/claim?token=${token}` });

    expect(claim.statusCode).toBe(302);
    expect(claim.headers['set-cookie']).toMatch(/rpow_session=/);
    const afterCounter = await ctx.pool.query<{ value: string }>("SELECT value FROM app_counters WHERE name='minted_supply'");
    expect(afterCounter.rows[0]!.value).toBe(beforeCounter.rows[0]!.value);
    const rootCount = await ctx.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM tokens WHERE parent_token_id IS NULL');
    expect(rootCount.rows[0]!.n).toBe(2);
    const children = await ctx.pool.query<{ parent_token_id: string }>(
      "SELECT parent_token_id FROM tokens WHERE owner_email='recipient@x.com' AND state='VALID' ORDER BY parent_token_id",
    );
    expect(children.rows.map((r) => r.parent_token_id).sort()).toEqual(parentIds.sort());
  });

  it('backfills source token records for legacy pending claims', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const senderCookie = await loginAs(ctx, 'sender@x.com');
    await mineN(ctx, senderCookie, 1);
    const tokenRow = (await ctx.pool.query<{ id: string }>(
      "SELECT id FROM tokens WHERE owner_email='sender@x.com' AND state='VALID' LIMIT 1",
    )).rows[0]!;
    await ctx.pool.query("UPDATE tokens SET state='INVALIDATED', invalidated_at=now() WHERE id=$1", [tokenRow.id]);

    const claimToken = 'legacy-claim-token';
    const claimHash = createHash('sha256').update(claimToken).digest();
    const pendingId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO pending_transfers
       (id, sender_email, recipient_email, amount, idempotency_key, claim_token_hash, expires_at)
       VALUES ($1, 'sender@x.com', 'recipient@x.com', 1, $2, $3, now() + interval '30 days')`,
      [pendingId, randomUUID(), claimHash],
    );
    const migration006 = await readFile(new URL('../migrations/006_pending_transfer_hardening.sql', import.meta.url), 'utf8');

    await ctx.pool.query(migration006);

    const backfilled = await ctx.pool.query<{ token_id: string }>(
      'SELECT token_id FROM pending_transfer_tokens WHERE pending_transfer_id=$1',
      [pendingId],
    );
    expect(backfilled.rows).toEqual([{ token_id: tokenRow.id }]);
    const claim = await ctx.app.inject({ method: 'GET', url: `/claim?token=${claimToken}` });
    expect(claim.statusCode).toBe(302);
    const minted = await ctx.pool.query<{ value: string }>("SELECT value FROM app_counters WHERE name='minted_supply'");
    expect(minted.rows[0]!.value).toBe('1');
  });

  it('remediates already-claimed legacy pending claims that minted root tokens', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const senderCookie = await loginAs(ctx, 'sender@x.com');
    await mineN(ctx, senderCookie, 1);
    const sourceToken = (await ctx.pool.query<{ id: string }>(
      "SELECT id FROM tokens WHERE owner_email='sender@x.com' AND state='VALID' LIMIT 1",
    )).rows[0]!;
    await ctx.pool.query("UPDATE tokens SET state='INVALIDATED', invalidated_at=now() WHERE id=$1", [sourceToken.id]);

    const pendingId = randomUUID();
    const claimedAt = new Date();
    const recipientRootId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO pending_transfers
       (id, sender_email, recipient_email, amount, idempotency_key, claim_token_hash, expires_at, claimed_at)
       VALUES ($1, 'sender@x.com', 'recipient@x.com', 1, $2, $3, $4, $4)`,
      [
        pendingId,
        randomUUID(),
        createHash('sha256').update('already-claimed-token').digest(),
        claimedAt,
      ],
    );
    await ctx.pool.query(
      `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
       VALUES($1, 'recipient@x.com', 1, 'VALID', $2, $3)`,
      [recipientRootId, claimedAt, Buffer.from('legacy-claim-root')],
    );
    await ctx.pool.query(
      `INSERT INTO transfers(id, sender_email, recipient_email, amount, idempotency_key, created_at)
       VALUES($1, 'sender@x.com', 'recipient@x.com', 1, $2, $3)`,
      [randomUUID(), `claim:${pendingId}`, claimedAt],
    );
    await ctx.pool.query("UPDATE app_counters SET value = value + 1 WHERE name='minted_supply'");

    const migration006 = await readFile(new URL('../migrations/006_pending_transfer_hardening.sql', import.meta.url), 'utf8');
    await ctx.pool.query(migration006);

    const backfilled = await ctx.pool.query<{ token_id: string }>(
      'SELECT token_id FROM pending_transfer_tokens WHERE pending_transfer_id=$1',
      [pendingId],
    );
    expect(backfilled.rows).toEqual([{ token_id: sourceToken.id }]);
    const remediatedRoot = await ctx.pool.query<{ parent_token_id: string | null }>(
      'SELECT parent_token_id FROM tokens WHERE id=$1',
      [recipientRootId],
    );
    expect(remediatedRoot.rows[0]!.parent_token_id).toBe(sourceToken.id);
    const minted = await ctx.pool.query<{ value: string }>("SELECT value FROM app_counters WHERE name='minted_supply'");
    expect(minted.rows[0]!.value).toBe('1');
    const rootCount = await ctx.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM tokens WHERE parent_token_id IS NULL');
    expect(rootCount.rows[0]!.n).toBe(1);
  });

  it('prioritizes live legacy pending rows over expired rows when backfilling scarce tokens', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const senderCookie = await loginAs(ctx, 'sender@x.com');
    await mineN(ctx, senderCookie, 1);
    const sourceToken = (await ctx.pool.query<{ id: string }>(
      "SELECT id FROM tokens WHERE owner_email='sender@x.com' AND state='VALID' LIMIT 1",
    )).rows[0]!;
    await ctx.pool.query("UPDATE tokens SET state='INVALIDATED', invalidated_at=now() WHERE id=$1", [sourceToken.id]);

    const expiredId = randomUUID();
    const liveId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO pending_transfers
       (id, sender_email, recipient_email, amount, idempotency_key, claim_token_hash, expires_at, created_at)
       VALUES ($1, 'sender@x.com', 'expired@x.com', 1, $2, $3, now() - interval '1 day', now() - interval '2 days'),
              ($4, 'sender@x.com', 'live@x.com', 1, $5, $6, now() + interval '30 days', now() - interval '1 day')`,
      [
        expiredId,
        randomUUID(),
        createHash('sha256').update('expired-token').digest(),
        liveId,
        randomUUID(),
        createHash('sha256').update('live-token').digest(),
      ],
    );

    const migration006 = await readFile(new URL('../migrations/006_pending_transfer_hardening.sql', import.meta.url), 'utf8');
    await ctx.pool.query(migration006);

    const liveBackfill = await ctx.pool.query<{ token_id: string }>(
      'SELECT token_id FROM pending_transfer_tokens WHERE pending_transfer_id=$1',
      [liveId],
    );
    const expiredBackfill = await ctx.pool.query<{ token_id: string }>(
      'SELECT token_id FROM pending_transfer_tokens WHERE pending_transfer_id=$1',
      [expiredId],
    );
    expect(liveBackfill.rows).toEqual([{ token_id: sourceToken.id }]);
    expect(expiredBackfill.rows).toEqual([]);
  });

  it('returns claim status for the web claim landing page', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const senderCookie = await loginAs(ctx, 'sender@x.com');
    await mineN(ctx, senderCookie, 1);
    await sendPending(ctx, senderCookie, 'recipient@x.com', 1);
    const token = latestTokenFromEmail(ctx);

    const status = await ctx.app.inject({ method: 'GET', url: `/claim/status?token=${token}` });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      ok: true,
      sender_email: 'sender@x.com',
      recipient_email: 'recipient@x.com',
      amount: 1,
      status: 'pending',
    });
    expect(status.json().expires_at).toEqual(expect.any(String));
  });

  it('claims via JSON API for the web claim landing page', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const senderCookie = await loginAs(ctx, 'sender@x.com');
    await mineN(ctx, senderCookie, 1);
    await sendPending(ctx, senderCookie, 'recipient@x.com', 1);
    const token = latestTokenFromEmail(ctx);

    const claim = await ctx.app.inject({
      method: 'POST',
      url: '/claim',
      headers: { 'content-type': 'application/json' },
      payload: { token },
    });

    expect(claim.statusCode).toBe(200);
    expect(claim.headers['set-cookie']).toMatch(/rpow_session=/);
    expect(claim.json()).toMatchObject({ ok: true, recipient_email: 'recipient@x.com', amount: 1 });
  });

  it('rejects an invalid claim token', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/claim?token=nope' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_CLAIM');
  });

  it('rejects an expired claim token without claiming or minting', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const senderCookie = await loginAs(ctx, 'sender@x.com');
    await mineN(ctx, senderCookie, 1);
    const send = await sendPending(ctx, senderCookie, 'recipient@x.com', 1);
    const token = latestTokenFromEmail(ctx);
    await ctx.pool.query('UPDATE pending_transfers SET expires_at = now() - interval \'1 minute\' WHERE id=$1', [send.json().transfer_id]);

    const res = await ctx.app.inject({ method: 'GET', url: `/claim?token=${token}` });

    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('CLAIM_EXPIRED');
    const recipientTokens = await ctx.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM tokens WHERE owner_email='recipient@x.com'");
    expect(recipientTokens.rows[0]!.n).toBe(0);
    const minted = await ctx.pool.query<{ value: string }>("SELECT value FROM app_counters WHERE name='minted_supply'");
    expect(minted.rows[0]!.value).toBe('1');
  });

  it('rejects a double claim', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const senderCookie = await loginAs(ctx, 'sender@x.com');
    await mineN(ctx, senderCookie, 1);
    await sendPending(ctx, senderCookie, 'recipient@x.com', 1);
    const token = latestTokenFromEmail(ctx);

    const first = await ctx.app.inject({ method: 'GET', url: `/claim?token=${token}` });
    const second = await ctx.app.inject({ method: 'GET', url: `/claim?token=${token}` });

    expect(first.statusCode).toBe(302);
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('ALREADY_CLAIMED');
  });

  it('sets a session cookie that can read the claimed wallet', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const senderCookie = await loginAs(ctx, 'sender@x.com');
    await mineN(ctx, senderCookie, 1);
    await sendPending(ctx, senderCookie, 'recipient@x.com', 1);
    const token = latestTokenFromEmail(ctx);

    const claim = await ctx.app.inject({ method: 'GET', url: `/claim?token=${token}` });
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: claim.headers['set-cookie'] as string } });

    expect(claim.statusCode).toBe(302);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: 'recipient@x.com', balance: 1 });
  });
});
