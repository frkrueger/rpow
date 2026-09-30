import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { signSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../src/session.js';
import { makeTestApp } from './helpers.js';
import { findSolutionForTest } from '../src/pow.js';

const BASE_UNITS_PER_RPOW = 1_000_000_000n;
const REWARD_BASE_UNITS = 10_000_000n;            // 0.01 RPOW per solution at production base
const SEND_AMOUNT_BASE_UNITS = 1_000_000n;        // 0.001 RPOW: tests change-token path
const MAX_SUPPLY_BASE_UNITS = 21n * BASE_UNITS_PER_RPOW;

async function loginAs(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.pool.query('INSERT INTO users(email) VALUES($1) ON CONFLICT DO NOTHING', [email]);
  ctx.config.operatorEmails.add(email); // Avoid elapsed-time cooldown in deterministic mint fixtures.
  return `${SESSION_COOKIE}=${signSession({ email }, ctx.config.sessionSecret, SESSION_TTL_SECONDS)}`;
}

async function mineN(ctx: Awaited<ReturnType<typeof makeTestApp>>, cookie: string, n: number) {
  for (let i = 0; i < n; i++) {
    const challenge = await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } });
    expect(challenge.statusCode, challenge.body).toBe(200);
    const ch = challenge.json();
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/mint',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
}

async function assertBalanceCaches(ctx: Awaited<ReturnType<typeof makeTestApp>>) {
  const { rows } = await ctx.pool.query(`SELECT users.email, users.cached_balance::text AS cached,
    coalesce(sum(tokens.value) FILTER (WHERE tokens.state = 'VALID'), 0)::text AS actual
    FROM users LEFT JOIN tokens ON tokens.owner_email = users.email
    GROUP BY users.email ORDER BY users.email`);
  for (const row of rows) expect(row.cached, row.email).toBe(row.actual);
  const supply = await ctx.pool.query(`SELECT
    (SELECT coalesce(sum(value),0)::text FROM app_counters WHERE name='circulating_supply_base_units') AS cached,
    (SELECT coalesce(sum(value),0)::text FROM tokens WHERE state='VALID') AS actual`);
  expect(supply.rows[0].cached).toBe(supply.rows[0].actual);
}

describe('GET /stats/*', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns public summary, current holder aggregates, and server-derived history', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const seedUsers = (await ctx.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    const aCookie = await loginAs(ctx, 'a@x.com');
    await loginAs(ctx, 'b@x.com');
    await mineN(ctx, aCookie, 3);

    // Send a sub-reward amount so we exercise the change-token path:
    // a starts with 3 × 10M tokens, sends 1M to b. Change = 9M back to a.
    // After: a holds [10M, 10M, 9M] = 29M; b holds [1M] = 1M.
    const send = await ctx.app.inject({
      method: 'POST',
      url: '/send',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { recipient_email: 'b@x.com', amount_base_units: SEND_AMOUNT_BASE_UNITS.toString(), idempotency_key: randomUUID() },
    });
    expect(send.statusCode).toBe(200);

    const totalMinted = 3n * REWARD_BASE_UNITS;       // 30M
    const aBalance = totalMinted - SEND_AMOUNT_BASE_UNITS;  // 29M
    const bBalance = SEND_AMOUNT_BASE_UNITS;          // 1M

    const summaryRes = await ctx.app.inject({ method: 'GET', url: '/stats/summary' });
    expect(summaryRes.statusCode).toBe(200);
    const summary = summaryRes.json();
    expect(summary.ledger).toMatchObject({
      total_minted_base_units: totalMinted.toString(),
      total_transferred_base_units: SEND_AMOUNT_BASE_UNITS.toString(),
      circulating_supply_base_units: totalMinted.toString(),
      minted_supply_counter_base_units: totalMinted.toString(),
      max_supply_base_units: MAX_SUPPLY_BASE_UNITS.toString(),
      base_units_per_rpow: BASE_UNITS_PER_RPOW.toString(),
      current_difficulty_bits: 8,
      current_reward_base_units: REWARD_BASE_UNITS.toString(),
      next_reward_base_units: (REWARD_BASE_UNITS / 2n).toString(),
      next_halving_at_base_units: MAX_SUPPLY_BASE_UNITS.toString(),
      base_units_to_next_halving: (MAX_SUPPLY_BASE_UNITS - totalMinted).toString(),
      halving_index: 0,
      is_capped: false,
      user_count: seedUsers + 2,
    });
    expect(summary.activity).toMatchObject({
      root_token_count_1h: 3,
      root_token_count_24h: 3,
      root_tokens_issued_base_units_1h: totalMinted.toString(),
      root_tokens_issued_base_units_24h: totalMinted.toString(),
      transfer_count_1h: 1,
      transfer_count_24h: 1,
      transferred_base_units_1h: SEND_AMOUNT_BASE_UNITS.toString(),
      transferred_base_units_24h: SEND_AMOUNT_BASE_UNITS.toString(),
      active_challengers_15m: 1,
      wrap_count_24h: 0,
      wrapped_base_units_24h: '0',
      bound_wallet_count: 0,
    });
    expect(summary.holders.holder_count).toBe(2);
    expect(summary.holders.zero_balance_user_count).toBe(seedUsers);
    expect(summary.holders.average_balance_base_units).toBe((totalMinted / 2n).toString());
    expect(summary.holders.top_balances).toEqual([
      { rank: 1, balance_base_units: aBalance.toString() },
      { rank: 2, balance_base_units: bBalance.toString() },
    ]);
    expect(summary.holders.balance_histogram).toEqual([
      {
        bucket: '0.001-0.01',
        min_balance_base_units: '1000000',
        max_balance_base_units: '9999999',
        holder_count: 1,
        total_balance_base_units: bBalance.toString(),
      },
      {
        bucket: '0.01-0.1',
        min_balance_base_units: '10000000',
        max_balance_base_units: '99999999',
        holder_count: 1,
        total_balance_base_units: aBalance.toString(),
      },
    ]);

    const historyRes = await ctx.app.inject({ method: 'GET', url: '/stats/history?window=24h&limit=10' });
    expect(historyRes.statusCode).toBe(200);
    const history = historyRes.json();
    expect(history.window).toBe('24h');
    expect(history.bucket_seconds).toBe(15 * 60);
    expect(history.rows.length).toBeGreaterThanOrEqual(1);
    const latest = history.rows.at(-1);
    expect(latest).toMatchObject({
      root_token_count: 3,
      root_tokens_issued_base_units: totalMinted.toString(),
      transfer_count: 1,
      transferred_base_units: SEND_AMOUNT_BASE_UNITS.toString(),
      new_users: seedUsers + 2,
      challenges: 3,
      active_challengers: 1,
    });
    expect(latest.holder_count).toBeUndefined();
    expect(latest.balance_histogram).toBeUndefined();
    expect(latest.top_balances).toBeUndefined();

    const allTime = (await ctx.app.inject({ method: 'GET', url: '/stats/history?window=all&limit=10' })).json();
    expect(allTime.window).toBe('all');
    expect(allTime.bucket_seconds).toBe(24 * 60 * 60);
  });

  it('allows configured public origins only on public stats routes', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;

    const stats = await ctx.app.inject({
      method: 'GET',
      url: '/stats/summary',
      headers: { origin: 'https://stats.example' },
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.headers['access-control-allow-origin']).toBe('https://stats.example');
    expect(stats.headers['access-control-allow-credentials']).toBeUndefined();

    const privateRoute = await ctx.app.inject({
      method: 'GET',
      url: '/me',
      headers: { origin: 'https://stats.example' },
    });
    expect(privateRoute.statusCode).toBe(401);
    expect(privateRoute.headers['access-control-allow-origin']).toBeUndefined();

    const webOrigin = await ctx.app.inject({
      method: 'GET',
      url: '/me',
      headers: { origin: 'http://web.test' },
    });
    expect(webOrigin.statusCode).toBe(401);
    expect(webOrigin.headers['access-control-allow-origin']).toBe('http://web.test');
    expect(webOrigin.headers['access-control-allow-credentials']).toBe('true');
  });
  it('keeps current cache and supply correct through send-to-new-user and claim without a second balance ledger', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await loginAs(ctx, 'sender@example.test');
    await mineN(ctx, cookie, 1);
    await assertBalanceCaches(ctx);
    const send = await ctx.app.inject({ method: 'POST', url: '/send', headers: { cookie }, payload: {
      recipient_email: 'recipient@example.test', amount_base_units: SEND_AMOUNT_BASE_UNITS.toString(), idempotency_key: randomUUID(),
    } });
    expect(send.statusCode, send.body).toBe(200);
    expect(send.json().pending).toBe(true);
    await assertBalanceCaches(ctx);
    const claimToken = ctx.mailer.outbox.at(-1)!.text.match(/claim\?token=([\w-]+)/)![1];
    const claim = await ctx.app.inject({ method: 'GET', url: `/claim?token=${claimToken}` });
    expect(claim.statusCode, claim.body).toBe(302);
    await assertBalanceCaches(ctx);
    const summary = (await ctx.app.inject({ method: 'GET', url: '/stats/summary' })).json();
    expect(summary.ledger.total_minted_base_units).toBe(REWARD_BASE_UNITS.toString());
    expect(summary.ledger.circulating_supply_base_units).toBe(REWARD_BASE_UNITS.toString());
    expect(summary.activity.root_token_count_24h).toBe(2); // Mining plus claim issuance, not two mined rewards.
    expect(summary.activity.root_tokens_issued_base_units_24h).toBe((REWARD_BASE_UNITS + SEND_AMOUNT_BASE_UNITS).toString());
    const history = (await ctx.app.inject({ method: 'GET', url: '/stats/history?limit=1' })).json();
    expect(history.rows[0].root_token_count).toBe(2);
    for (const field of ['total_minted_base_units', 'circulating_supply_base_units', 'current_reward_base_units', 'current_difficulty_bits', 'mint_count']) {
      expect(history.rows[0]).not.toHaveProperty(field);
    }
    expect((await ctx.pool.query("SELECT to_regclass('user_balances') AS relation")).rows[0].relation).toBeNull();
  });

  it('reports AMM root issuance separately and reads the lower authoritative supply after a real AMM burn', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await loginAs(ctx, 'buyer@example.test');
    await ctx.pool.query("UPDATE users SET amm_terms_accepted_at=now(), usdc_base_units=1000000 WHERE email='buyer@example.test'");
    await ctx.pool.query(`INSERT INTO amm_pool(rpow_reserve_base_units, usdc_reserve_base_units, total_lp_supply)
      VALUES (1000000000, 100000000, 10000000000)`);
    const bought = await ctx.app.inject({ method: 'POST', url: '/amm/buy', headers: { cookie }, payload: { usdc_base_units: '1000000', min_rpow_out: '0' } });
    expect(bought.statusCode, bought.body).toBe(200);
    const issued = BigInt(bought.json().rpow_received);
    await assertBalanceCaches(ctx);
    const burned = issued / 2n;
    const sold = await ctx.app.inject({ method: 'POST', url: '/amm/sell', headers: { cookie }, payload: { rpow_base_units: burned.toString(), min_usdc_out: '0' } });
    expect(sold.statusCode, sold.body).toBe(200);
    await assertBalanceCaches(ctx);
    const summary = (await ctx.app.inject({ method: 'GET', url: '/stats/summary' })).json();
    expect(summary.ledger.total_minted_base_units).toBe((issued - burned).toString());
    expect(summary.ledger.circulating_supply_base_units).toBe((issued - burned).toString());
    expect(summary.holders.top_balances).toEqual([{ rank: 1, balance_base_units: (issued - burned).toString() }]);
    expect(summary.activity.root_token_count_24h).toBe(1);
    expect(summary.activity.root_tokens_issued_base_units_24h).toBe(issued.toString());
    const history = (await ctx.app.inject({ method: 'GET', url: '/stats/history?limit=1' })).json();
    expect(history.rows[0].root_tokens_issued_base_units).toBe(issued.toString());
    expect(history.rows[0]).not.toHaveProperty('total_minted_base_units');
  });

  it('sums nonzero counter shards, explicit wrapped supply and the configured current reward', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    ctx.config.baseRewardBaseUnits = 25000000n;
    ctx.config.difficultyFloor = 11;
    await ctx.pool.query(`UPDATE app_counters SET value=CASE shard WHEN 17 THEN 111 WHEN 127 THEN 222 ELSE 0 END WHERE name='minted_supply'`);
    await ctx.pool.query(`UPDATE app_counters SET value=CASE shard WHEN 96 THEN 333 ELSE 0 END WHERE name='total_transferred_base_units'`);
    await ctx.pool.query(`UPDATE app_counters SET value=CASE shard WHEN 19 THEN 444 ELSE 0 END WHERE name='wrapped_supply_base_units'`);
    const summary = (await ctx.app.inject({ method: 'GET', url: '/stats/summary' })).json();
    expect(summary.ledger).toMatchObject({ total_minted_base_units: '333', total_transferred_base_units: '333', wrapped_supply_base_units: '444', current_reward_base_units: '25000000', current_difficulty_bits: 11 });
  });

  it('retains the upstream mint supply guard without any stats balance gate', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await loginAs(ctx, 'cap@example.test');
    const ch = (await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } })).json();
    await ctx.pool.query("UPDATE app_counters SET value=CASE shard WHEN 127 THEN $1::bigint ELSE 0 END WHERE name='minted_supply'", [MAX_SUPPLY_BASE_UNITS.toString()]);
    const nonce = findSolutionForTest(Buffer.from(ch.nonce_prefix, 'hex'), ch.difficulty_bits);
    const res = await ctx.app.inject({ method: 'POST', url: '/mint', headers: { cookie }, payload: { challenge_id: ch.challenge_id, solution_nonce: nonce.toString() } });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('SUPPLY_EXHAUSTED');
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM tokens')).rows[0].n).toBe(0);
  });

  it('can backfill pre-migration holders using the existing upstream script before reporting holder distribution', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await loginAs(ctx, 'legacy@example.test');
    // Recreate only the pre-036 cache state in this disposable schema.
    await ctx.pool.query('DROP TRIGGER tokens_maintain_user_balance_cache ON tokens');
    await ctx.pool.query("INSERT INTO tokens(id,owner_email,value,state,server_sig) VALUES($1,'legacy@example.test',123456789,'VALID',$2)", [randomUUID(), Buffer.alloc(64)]);
    await ctx.pool.query('ALTER TABLE users DROP COLUMN cached_balance, DROP COLUMN cached_wrapped, DROP COLUMN cached_minted');
    await ctx.pool.query(await readFile(new URL('../migrations/036_user_balance_cache.sql', import.meta.url), 'utf8'));
    expect((await ctx.pool.query("SELECT cached_balance::text AS balance FROM users WHERE email='legacy@example.test'")).rows[0].balance).toBe('0');
    const script = await readFile(new URL('../../../scripts/backfill-user-balance-cache.sql', import.meta.url), 'utf8');
    await ctx.pool.query(script.split('\n').filter(line => !line.startsWith('\\')).join('\n'));
    await assertBalanceCaches(ctx);
    const summary = (await ctx.app.inject({ method: 'GET', url: '/stats/summary' })).json();
    expect(summary.holders.top_balances).toEqual([{ rank: 1, balance_base_units: '123456789' }]);
    // Future token state changes are maintained by upstream's trigger.
    await ctx.pool.query("UPDATE tokens SET state='INVALIDATED',invalidated_at=now() WHERE owner_email='legacy@example.test'");
    await assertBalanceCaches(ctx);
  });

  it('returns aggregate data only, with exact decimal strings above Number safe range', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await loginAs(ctx, 'private@example.test');
    await ctx.pool.query("UPDATE users SET solana_wallet='private-wallet-reference' WHERE email='private@example.test'");
    const amount = '9007199254740993';
    const id = randomUUID();
    await ctx.pool.query("INSERT INTO tokens(id,owner_email,value,state,server_sig) VALUES($1,'private@example.test',$2,'VALID',$3)", [id, amount, Buffer.alloc(64)]);
    const summary = await ctx.app.inject({ method: 'GET', url: '/stats/summary' });
    const history = await ctx.app.inject({ method: 'GET', url: '/stats/history?limit=1' });
    expect(summary.json().holders.top_balances[0].balance_base_units).toBe(amount);
    expect(history.json().rows[0].root_tokens_issued_base_units).toBe(amount);
    for (const body of [summary.body, history.body]) {
      expect(body).not.toContain('private@example.test');
      expect(body).not.toContain('private-wallet-reference');
      expect(body).not.toContain(id);
      expect(body).not.toContain('server_sig');
    }
  });

  it('keeps every upstream app origin credentialed while blocking unconfigured and non-read public preflights', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    for (const origin of [ctx.config.webOrigin, ctx.config.longShotWebOrigin, ctx.config.gladiatorWebOrigin, ctx.config.triviaWebOrigin, ctx.config.freelotteryWebOrigin, ctx.config.chatWebOrigin]) {
      const result = await ctx.app.inject({ method: 'GET', url: '/me', headers: { origin } });
      expect(result.headers['access-control-allow-origin']).toBe(origin);
      expect(result.headers['access-control-allow-credentials']).toBe('true');
    }
    for (const [origin, path, method] of [
      ['https://unconfigured.example', '/stats/summary', 'GET'],
      ['https://stats.example', '/send', 'POST'],
      ['https://stats.example', '/stats/summary', 'POST'],
      ['https://stats.example', '/stats/summary/extra', 'GET'],
    ]) {
      const result = await ctx.app.inject({ method: 'OPTIONS', url: path, headers: { origin, 'access-control-request-method': method } });
      expect(result.headers['access-control-allow-origin']).toBeUndefined();
    }
    const allowed = await ctx.app.inject({ method: 'OPTIONS', url: '/stats/history?window=7d', headers: { origin: 'https://stats.example', 'access-control-request-method': 'GET' } });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://stats.example');
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('bounds and validates history, zero fills empty buckets, and omits unsupported historic balances', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const seedUsers = (await ctx.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    for (const query of ['window=wrong', 'limit=0', 'limit=1001', 'limit=1.5', 'limit=NaN']) {
      expect((await ctx.app.inject({ method: 'GET', url: `/stats/history?${query}` })).statusCode).toBe(400);
    }
    for (const window of ['24h', '7d', '30d', 'all']) {
      const response = await ctx.app.inject({ method: 'GET', url: `/stats/history?window=${window}&limit=2` });
      expect(response.statusCode, response.body).toBe(200);
      const { rows } = response.json();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(2);
      expect(rows.at(-1)).toEqual({ bucket_start: expect.any(String), root_token_count: 0, root_tokens_issued_base_units: '0', transfer_count: 0, transferred_base_units: '0', new_users: seedUsers, challenges: 0, active_challengers: 0 });
    }
  });

  it.each(['confirmed', 'refunded'] as const)('retains cache consistency through upstream wrap %s state transitions', async (outcome) => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: 'wrap@example.test' }); cleanup = ctx.cleanup;
    const cookie = await loginAs(ctx, 'wrap@example.test');
    await mineN(ctx, cookie, 1);
    await ctx.pool.query("UPDATE users SET solana_wallet='fixture-wallet' WHERE email='wrap@example.test'");
    ctx.bridgeClient.queueResult(outcome === 'confirmed' ? { signature: 'fixture-confirmed' } : { error: 'fixture failure' });
    const result = await ctx.app.inject({ method: 'POST', url: '/srpow/wrap', headers: { cookie }, payload: { amount_base_units: SEND_AMOUNT_BASE_UNITS.toString(), idempotency_key: randomUUID() } });
    expect(result.statusCode, result.body).toBe(outcome === 'confirmed' ? 200 : 503);
    await assertBalanceCaches(ctx);
    const states = (await ctx.pool.query("SELECT coalesce(sum(value) FILTER (WHERE state='WRAPPED'),0)::text AS wrapped FROM tokens")).rows[0];
    const summary = (await ctx.app.inject({ method: 'GET', url: '/stats/summary' })).json();
    expect(summary.ledger.wrapped_supply_base_units).toBe(states.wrapped);
    expect(summary.activity.wrap_count_24h).toBe(outcome === 'confirmed' ? 1 : 0);
  });

  it('keeps a concurrent token write consistent when the existing backfill runs under a token-table maintenance lock', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await loginAs(ctx, 'backfill@example.test');
    const script = (await readFile(new URL('../../../scripts/backfill-user-balance-cache.sql', import.meta.url), 'utf8'))
      .split('\n').filter(line => !line.startsWith('\\')).join('\n');
    const maintenance = await ctx.pool.connect();
    const writer = await ctx.pool.connect();
    let inserted: Promise<unknown> | undefined;
    try {
      await maintenance.query('BEGIN');
      await maintenance.query('LOCK TABLE tokens IN SHARE MODE');
      await writer.query('SET statement_timeout = 5000');
      let settled = false;
      inserted = writer.query("INSERT INTO tokens(id,owner_email,value,state,server_sig) VALUES($1,'backfill@example.test',555,'VALID',$2)", [randomUUID(), Buffer.alloc(64)])
        .then(result => { settled = true; return result; });
      // Observe a real PostgreSQL lock wait, rather than relying on a sleep.
      const pid = writer.processID;
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const result = await maintenance.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid]);
        waiting = result.rows[0]?.wait_event_type === 'Lock';
      }
      expect(waiting).toBe(true);
      expect(settled).toBe(false);
      await maintenance.query(script);
      await maintenance.query('COMMIT');
      await inserted;
      await assertBalanceCaches(ctx);
      expect((await ctx.pool.query("SELECT cached_balance::text AS balance FROM users WHERE email='backfill@example.test'")).rows[0].balance).toBe('555');
    } finally {
      await maintenance.query('ROLLBACK');
      await inserted?.catch(() => {});
      maintenance.release();
      writer.release();
    }
  });

});
