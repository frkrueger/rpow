import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { hashApiKey } from '../src/routes/auth.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

// ── Helpers ─────────────────────────────────────────────────────────

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;

async function loginAs(ctx: Ctx, email: string): Promise<string> {
  return ctx.forgeSessionCookie(email);
}

async function seedToken(ctx: Ctx, ownerEmail: string, valueBaseUnits: bigint): Promise<string> {
  const id = randomUUID();
  await ctx.pool.query(
    `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
     VALUES($1, $2, $3, 'VALID', now(), $4)`,
    [id, ownerEmail, valueBaseUnits.toString(), Buffer.from('00'.repeat(64), 'hex')],
  );
  return id;
}

function makePreimage(): { preimageHex: string; hashHex: string } {
  const preimage = randomBytes(32);
  const hash = createHash('sha256').update(preimage).digest();
  return { preimageHex: preimage.toString('hex'), hashHex: hash.toString('hex') };
}

async function getBalance(ctx: Ctx, cookie: string): Promise<bigint> {
  const res = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
  return BigInt(res.json().balance_base_units);
}

async function countTokensByState(ctx: Ctx, email: string, state: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM tokens WHERE owner_email = $1 AND state = $2`,
    [email, state],
  );
  return Number(rows[0].n);
}

async function sumTokensByState(ctx: Ctx, email: string, state: string): Promise<bigint> {
  const { rows } = await ctx.pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(value), 0)::text AS total FROM tokens WHERE owner_email = $1 AND state = $2`,
    [email, state],
  );
  return BigInt(rows[0].total);
}

async function totalValidSupply(ctx: Ctx): Promise<bigint> {
  const { rows } = await ctx.pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(value), 0)::text AS total FROM tokens WHERE state = 'VALID'`,
  );
  return BigInt(rows[0].total);
}

async function totalHashlockedSupply(ctx: Ctx): Promise<bigint> {
  const { rows } = await ctx.pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(value), 0)::text AS total FROM tokens WHERE state = 'HASHLOCKED'`,
  );
  return BigInt(rows[0].total);
}

async function createHashlock(
  ctx: Ctx,
  cookie: string,
  recipient: string,
  amountBaseUnits: bigint,
  hashHex: string,
  opts: { timeout?: number; idem?: string } = {},
) {
  const res = await ctx.app.inject({
    method: 'POST', url: '/hashlock',
    headers: { cookie, 'content-type': 'application/json' },
    payload: {
      recipient_email: recipient,
      amount_base_units: amountBaseUnits.toString(),
      hash_h_hex: hashHex,
      timeout_seconds: opts.timeout ?? 3600,
      idempotency_key: opts.idem ?? randomUUID(),
    },
  });
  return res;
}

async function claimHashlock(ctx: Ctx, cookie: string, hlId: string, preimageHex: string) {
  return ctx.app.inject({
    method: 'POST', url: `/hashlock/${hlId}/claim`,
    headers: { cookie, 'content-type': 'application/json' },
    payload: { preimage_hex: preimageHex },
  });
}

async function refundHashlock(ctx: Ctx, cookie: string, hlId: string) {
  return ctx.app.inject({
    method: 'POST', url: `/hashlock/${hlId}/refund`,
    headers: { cookie, 'content-type': 'application/json' },
  });
}

async function getHashlockState(ctx: Ctx, hlId: string) {
  return ctx.app.inject({ method: 'GET', url: `/hashlock/${hlId}` });
}

async function expireHashlock(ctx: Ctx, hlId: string) {
  await ctx.pool.query(
    `UPDATE hashlocked_transfers SET expires_at = now() - interval '1 second' WHERE id = $1`,
    [hlId],
  );
}

/** Extract hashlock_id from a create response. */
function hlId(res: { json: () => any }): string {
  return res.json().hashlock_id;
}

async function seedUserAndKey(ctx: Ctx, email: string): Promise<{ plaintext: string }> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES($1) ON CONFLICT (email) DO NOTHING`, [email]);
  const plaintext = 'rpow_sk_' + randomBytes(32).toString('base64url');
  const hash = hashApiKey(plaintext);
  await ctx.pool.query(
    `INSERT INTO api_keys(email, token_hash, token_prefix) VALUES($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET token_hash = EXCLUDED.token_hash, token_prefix = EXCLUDED.token_prefix`,
    [email, hash, plaintext.slice(0, 12)],
  );
  return { plaintext };
}

async function seedUserWithWallet(ctx: Ctx, email: string, wallet: string, valueBaseUnits: bigint): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO users(email, solana_wallet) VALUES($1, $2) ON CONFLICT (email) DO UPDATE SET solana_wallet = $2`,
    [email, wallet],
  );
  await seedToken(ctx, email, valueBaseUnits);
}

const ONE_RPOW = 1_000_000_000n;

// ─────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────

describe('hashlock', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  // ═══════════════════════════════════════════════════════════════════
  // 1. CORE LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════

  describe('core lifecycle', () => {
    it('lock → claim with correct preimage', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 3n * ONE_RPOW);

      const { preimageHex, hashHex } = makePreimage();
      const lockRes = await createHashlock(ctx, aCookie, 'bob@test.com', 2n * ONE_RPOW, hashHex);
      expect(lockRes.statusCode).toBe(200);
      const lockData = lockRes.json();
      expect(lockData.state).toBe('PENDING');
      expect(lockData.amount_base_units).toBe((2n * ONE_RPOW).toString());
      expect(lockData.recipient_email).toBe('bob@test.com');
      expect(lockData.hashlock_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(lockData.expires_at).toBeTruthy();

      // Alice balance reduced by locked amount.
      expect(await getBalance(ctx, aCookie)).toBe(ONE_RPOW);

      // Bob claims.
      const claimRes = await claimHashlock(ctx, bCookie, lockData.hashlock_id, preimageHex);
      expect(claimRes.statusCode).toBe(200);
      expect(claimRes.json().state).toBe('CLAIMED');
      expect(claimRes.json().preimage_hex).toBe(preimageHex);

      // Bob has 2 RPOW, Alice still has 1 RPOW.
      expect(await getBalance(ctx, bCookie)).toBe(2n * ONE_RPOW);
      expect(await getBalance(ctx, aCookie)).toBe(ONE_RPOW);
    });

    it('lock → refund after expiry returns tokens to sender', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 3n * ONE_RPOW);

      const { hashHex } = makePreimage();
      const lockRes = await createHashlock(ctx, aCookie, 'bob@test.com', 2n * ONE_RPOW, hashHex);
      const lockId = hlId(lockRes);

      expect(await getBalance(ctx, aCookie)).toBe(ONE_RPOW);

      await expireHashlock(ctx, lockId);

      const refundRes = await refundHashlock(ctx, aCookie, lockId);
      expect(refundRes.statusCode).toBe(200);
      expect(refundRes.json().state).toBe('REFUNDED');

      // Full balance restored.
      expect(await getBalance(ctx, aCookie)).toBe(3n * ONE_RPOW);
    });

    it('GET returns full state at each lifecycle stage', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { preimageHex, hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));

      // PENDING state.
      const pending = (await getHashlockState(ctx, lockId)).json();
      expect(pending.state).toBe('PENDING');
      expect(pending.sender_email).toBe('alice@test.com');
      expect(pending.recipient_email).toBe('bob@test.com');
      expect(pending.amount_base_units).toBe(ONE_RPOW.toString());
      expect(pending.hash_h_hex).toBe(hashHex);
      expect(pending.preimage_hex).toBeNull();
      expect(pending.claimed_at).toBeNull();
      expect(pending.created_at).toBeTruthy();
      expect(pending.expires_at).toBeTruthy();

      // CLAIMED state.
      await claimHashlock(ctx, bCookie, lockId, preimageHex);
      const claimed = (await getHashlockState(ctx, lockId)).json();
      expect(claimed.state).toBe('CLAIMED');
      expect(claimed.preimage_hex).toBe(preimageHex);
      expect(claimed.claimed_at).toBeTruthy();
    });

    it('GET returns REFUNDED state with no preimage', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));
      await expireHashlock(ctx, lockId);
      await refundHashlock(ctx, aCookie, lockId);

      const refunded = (await getHashlockState(ctx, lockId)).json();
      expect(refunded.state).toBe('REFUNDED');
      expect(refunded.preimage_hex).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. NUMERICAL PRECISION
  // ═══════════════════════════════════════════════════════════════════

  describe('numerical precision', () => {
    it('handles minimum amount (1 base unit)', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { preimageHex, hashHex } = makePreimage();
      const lockRes = await createHashlock(ctx, aCookie, 'bob@test.com', 1n, hashHex);
      expect(lockRes.statusCode).toBe(200);
      expect(lockRes.json().amount_base_units).toBe('1');

      // Change = 999999999.
      expect(await getBalance(ctx, aCookie)).toBe(ONE_RPOW - 1n);

      const claimRes = await claimHashlock(ctx, bCookie, hlId(lockRes), preimageHex);
      expect(claimRes.statusCode).toBe(200);
      expect(await getBalance(ctx, bCookie)).toBe(1n);
    });

    it('handles large amount (10^18 base units)', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      const large = 10n ** 18n;
      await seedToken(ctx, 'alice@test.com', large);

      const { preimageHex, hashHex } = makePreimage();
      const lockRes = await createHashlock(ctx, aCookie, 'bob@test.com', large, hashHex);
      expect(lockRes.statusCode).toBe(200);
      expect(await getBalance(ctx, aCookie)).toBe(0n);

      const claimRes = await claimHashlock(ctx, bCookie, hlId(lockRes), preimageHex);
      expect(claimRes.statusCode).toBe(200);
      expect(await getBalance(ctx, bCookie)).toBe(large);
    });

    it('exact balance — no change token created', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 5n * ONE_RPOW);

      const { hashHex } = makePreimage();
      await createHashlock(ctx, aCookie, 'bob@test.com', 5n * ONE_RPOW, hashHex);

      expect(await getBalance(ctx, aCookie)).toBe(0n);
      expect(await countTokensByState(ctx, 'alice@test.com', 'VALID')).toBe(0);
    });

    it('change token has exact correct value', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 7n * ONE_RPOW);

      const { hashHex } = makePreimage();
      await createHashlock(ctx, aCookie, 'bob@test.com', 3n * ONE_RPOW, hashHex);

      expect(await getBalance(ctx, aCookie)).toBe(4n * ONE_RPOW);

      const { rows } = await ctx.pool.query<{ value: string }>(
        `SELECT value::text AS value FROM tokens
         WHERE owner_email = 'alice@test.com' AND state = 'VALID'`,
      );
      expect(rows).toHaveLength(1);
      expect(BigInt(rows[0].value)).toBe(4n * ONE_RPOW);
    });

    it('sub-RPOW fractional amounts preserved exactly', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      const fractional = 123_456_789n;
      await seedToken(ctx, 'alice@test.com', fractional);

      const { preimageHex, hashHex } = makePreimage();
      const lockRes = await createHashlock(ctx, aCookie, 'bob@test.com', fractional, hashHex);
      expect(lockRes.statusCode).toBe(200);
      expect(lockRes.json().amount_base_units).toBe('123456789');

      await claimHashlock(ctx, bCookie, hlId(lockRes), preimageHex);
      expect(await getBalance(ctx, bCookie)).toBe(fractional);
    });

    it('zero-sum: sender_loss == recipient_gain across lock + claim', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      const initial = 10n * ONE_RPOW;
      await seedToken(ctx, 'alice@test.com', initial);

      const beforeA = await getBalance(ctx, aCookie);
      const beforeB = await getBalance(ctx, bCookie);
      expect(beforeA).toBe(initial);
      expect(beforeB).toBe(0n);

      const { preimageHex, hashHex } = makePreimage();
      const amount = 3n * ONE_RPOW;
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', amount, hashHex));
      await claimHashlock(ctx, bCookie, lockId, preimageHex);

      const afterA = await getBalance(ctx, aCookie);
      const afterB = await getBalance(ctx, bCookie);

      expect(beforeA - afterA).toBe(amount);
      expect(afterB - beforeB).toBe(amount);
      expect(afterA + afterB).toBe(beforeA + beforeB);
    });

    it('zero-sum: refund restores exact original balance', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 5n * ONE_RPOW);
      await seedToken(ctx, 'alice@test.com', 3n * ONE_RPOW);

      const beforeA = await getBalance(ctx, aCookie);
      expect(beforeA).toBe(8n * ONE_RPOW);

      const { hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', 6n * ONE_RPOW, hashHex));
      await expireHashlock(ctx, lockId);
      await refundHashlock(ctx, aCookie, lockId);

      expect(await getBalance(ctx, aCookie)).toBe(beforeA);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. MULTI-TOKEN ACCUMULATION
  // ═══════════════════════════════════════════════════════════════════

  describe('multi-token accumulation', () => {
    it('accumulates across multiple small tokens', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      for (let i = 0; i < 10; i++) {
        await seedToken(ctx, 'alice@test.com', ONE_RPOW / 2n);
      }

      const { preimageHex, hashHex } = makePreimage();
      const lockRes = await createHashlock(ctx, aCookie, 'bob@test.com', 3n * ONE_RPOW, hashHex);
      expect(lockRes.statusCode).toBe(200);

      expect(await getBalance(ctx, aCookie)).toBe(2n * ONE_RPOW);

      await claimHashlock(ctx, bCookie, hlId(lockRes), preimageHex);
      expect(await getBalance(ctx, bCookie)).toBe(3n * ONE_RPOW);
    });

    it('greedy selection uses largest tokens first', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 5n * ONE_RPOW);
      await seedToken(ctx, 'alice@test.com', 3n * ONE_RPOW);
      await seedToken(ctx, 'alice@test.com', 2n * ONE_RPOW);
      await seedToken(ctx, 'alice@test.com', 1n * ONE_RPOW);

      const { hashHex } = makePreimage();
      await createHashlock(ctx, aCookie, 'bob@test.com', 4n * ONE_RPOW, hashHex);

      // Remaining: 3 + 2 + 1 + 1 (change) = 7 RPOW.
      expect(await getBalance(ctx, aCookie)).toBe(7n * ONE_RPOW);
      expect(await countTokensByState(ctx, 'alice@test.com', 'HASHLOCKED')).toBe(1);
      expect(await sumTokensByState(ctx, 'alice@test.com', 'HASHLOCKED')).toBe(5n * ONE_RPOW);
    });

    it('accumulates heterogeneous denominations', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      // 1 RPOW + 0.5 RPOW + 0.001 RPOW + 1/128 RPOW = 1,508,812,500 base units
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);
      await seedToken(ctx, 'alice@test.com', 500_000_000n);
      await seedToken(ctx, 'alice@test.com', 1_000_000n);
      await seedToken(ctx, 'alice@test.com', 7_812_500n);

      const { preimageHex, hashHex } = makePreimage();
      const lockRes = await createHashlock(ctx, aCookie, 'bob@test.com', 1_500_000_000n, hashHex);
      expect(lockRes.statusCode).toBe(200);

      await claimHashlock(ctx, bCookie, hlId(lockRes), preimageHex);
      expect(await getBalance(ctx, bCookie)).toBe(1_500_000_000n);
      expect(await getBalance(ctx, aCookie)).toBe(8_812_500n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. STATE MACHINE INTEGRITY
  // ═══════════════════════════════════════════════════════════════════

  describe('state machine', () => {
    it('cannot claim twice', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { preimageHex, hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));

      expect((await claimHashlock(ctx, bCookie, lockId, preimageHex)).statusCode).toBe(200);
      expect((await claimHashlock(ctx, bCookie, lockId, preimageHex)).statusCode).toBe(409);

      // Bob still has exactly 1 RPOW.
      expect(await getBalance(ctx, bCookie)).toBe(ONE_RPOW);
    });

    it('cannot refund a claimed hashlock', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { preimageHex, hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));

      await claimHashlock(ctx, bCookie, lockId, preimageHex);
      await expireHashlock(ctx, lockId);

      const res = await refundHashlock(ctx, aCookie, lockId);
      expect(res.statusCode).toBe(409);
    });

    it('cannot claim a refunded hashlock', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { preimageHex, hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));

      await expireHashlock(ctx, lockId);
      await refundHashlock(ctx, aCookie, lockId);

      const res = await claimHashlock(ctx, bCookie, lockId, preimageHex);
      expect(res.statusCode).toBe(409);
    });

    it('cannot refund twice', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));

      await expireHashlock(ctx, lockId);
      expect((await refundHashlock(ctx, aCookie, lockId)).statusCode).toBe(200);
      expect((await refundHashlock(ctx, aCookie, lockId)).statusCode).toBe(409);

      expect(await getBalance(ctx, aCookie)).toBe(ONE_RPOW);
    });

    it('cannot claim after expiry', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { preimageHex, hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));
      await expireHashlock(ctx, lockId);

      const res = await claimHashlock(ctx, bCookie, lockId, preimageHex);
      expect(res.statusCode).toBe(410);
    });

    it('cannot refund before expiry', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));

      const res = await refundHashlock(ctx, aCookie, lockId);
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('not yet expired');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. TOKEN STATE TRANSITIONS (DB-level)
  // ═══════════════════════════════════════════════════════════════════

  describe('token state transitions', () => {
    it('lock: tokens go VALID → HASHLOCKED with hashlock_id set', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      const tokenId = await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));

      const { rows } = await ctx.pool.query<{ state: string; hashlock_id: string | null }>(
        'SELECT state, hashlock_id::text FROM tokens WHERE id = $1', [tokenId],
      );
      expect(rows[0].state).toBe('HASHLOCKED');
      expect(rows[0].hashlock_id).toBe(lockId);
    });

    it('claim: locked tokens go HASHLOCKED → INVALIDATED', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      const tokenId = await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { preimageHex, hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));
      await claimHashlock(ctx, bCookie, lockId, preimageHex);

      const { rows } = await ctx.pool.query<{ state: string; invalidated_at: Date | null }>(
        'SELECT state, invalidated_at FROM tokens WHERE id = $1', [tokenId],
      );
      expect(rows[0].state).toBe('INVALIDATED');
      expect(rows[0].invalidated_at).toBeTruthy();
    });

    it('claim: recipient token created VALID with real server_sig', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { preimageHex, hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));
      await claimHashlock(ctx, bCookie, lockId, preimageHex);

      const { rows } = await ctx.pool.query<{ value: string; state: string; server_sig: Buffer }>(
        `SELECT value::text AS value, state, server_sig FROM tokens
         WHERE owner_email = 'bob@test.com' AND state = 'VALID'`,
      );
      expect(rows).toHaveLength(1);
      expect(BigInt(rows[0].value)).toBe(ONE_RPOW);
      expect(rows[0].server_sig.length).toBe(64); // ed25519 sig
    });

    it('refund: tokens go HASHLOCKED → VALID with hashlock_id cleared', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      const tokenId = await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));
      await expireHashlock(ctx, lockId);
      await refundHashlock(ctx, aCookie, lockId);

      const { rows } = await ctx.pool.query<{ state: string; hashlock_id: string | null }>(
        'SELECT state, hashlock_id::text FROM tokens WHERE id = $1', [tokenId],
      );
      expect(rows[0].state).toBe('VALID');
      expect(rows[0].hashlock_id).toBeNull();
    });

    it('no orphaned HASHLOCKED tokens after claim', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { preimageHex, hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', 2n * ONE_RPOW, hashHex));
      await claimHashlock(ctx, bCookie, lockId, preimageHex);

      const count = await countTokensByState(ctx, 'alice@test.com', 'HASHLOCKED');
      expect(count).toBe(0);
    });

    it('no orphaned HASHLOCKED tokens after refund', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));
      await expireHashlock(ctx, lockId);
      await refundHashlock(ctx, aCookie, lockId);

      const { rows } = await ctx.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tokens WHERE state = 'HASHLOCKED'`,
      );
      expect(Number(rows[0].n)).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. CONCURRENT / MULTIPLE HASHLOCKS
  // ═══════════════════════════════════════════════════════════════════

  describe('concurrent operations', () => {
    it('sender can have multiple pending hashlocks', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await loginAs(ctx, 'carol@test.com');
      await seedToken(ctx, 'alice@test.com', 10n * ONE_RPOW);

      const h1 = makePreimage();
      const h2 = makePreimage();

      expect((await createHashlock(ctx, aCookie, 'bob@test.com', 3n * ONE_RPOW, h1.hashHex)).statusCode).toBe(200);
      expect((await createHashlock(ctx, aCookie, 'carol@test.com', 4n * ONE_RPOW, h2.hashHex)).statusCode).toBe(200);

      expect(await getBalance(ctx, aCookie)).toBe(3n * ONE_RPOW);
      expect(await sumTokensByState(ctx, 'alice@test.com', 'HASHLOCKED')).toBeGreaterThanOrEqual(7n * ONE_RPOW);
    });

    it('claiming one hashlock does not affect another', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      const cCookie = await loginAs(ctx, 'carol@test.com');
      await seedToken(ctx, 'alice@test.com', 10n * ONE_RPOW);

      const h1 = makePreimage();
      const h2 = makePreimage();

      const hl1 = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', 3n * ONE_RPOW, h1.hashHex));
      const hl2 = hlId(await createHashlock(ctx, aCookie, 'carol@test.com', 4n * ONE_RPOW, h2.hashHex));

      await claimHashlock(ctx, bCookie, hl1, h1.preimageHex);
      expect(await getBalance(ctx, bCookie)).toBe(3n * ONE_RPOW);

      // Second still pending.
      expect((await getHashlockState(ctx, hl2)).json().state).toBe('PENDING');

      await claimHashlock(ctx, cCookie, hl2, h2.preimageHex);
      expect(await getBalance(ctx, cCookie)).toBe(4n * ONE_RPOW);
      expect(await getBalance(ctx, aCookie)).toBe(3n * ONE_RPOW);
    });

    it('insufficient balance for second hashlock', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 5n * ONE_RPOW);

      const h1 = makePreimage();
      const h2 = makePreimage();

      expect((await createHashlock(ctx, aCookie, 'bob@test.com', 3n * ONE_RPOW, h1.hashHex)).statusCode).toBe(200);

      const res2 = await createHashlock(ctx, aCookie, 'bob@test.com', 3n * ONE_RPOW, h2.hashHex);
      expect(res2.statusCode).toBe(400);
      expect(res2.json().error).toBe('INSUFFICIENT_BALANCE');
    });

    it('refunding frees balance for new hashlock', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 5n * ONE_RPOW);

      const h1 = makePreimage();
      const h2 = makePreimage();

      const hl1 = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', 4n * ONE_RPOW, h1.hashHex));

      // Can't lock 4 more.
      expect((await createHashlock(ctx, aCookie, 'bob@test.com', 4n * ONE_RPOW, h2.hashHex)).statusCode).toBe(400);

      // Refund first → balance restored → second lock succeeds.
      await expireHashlock(ctx, hl1);
      await refundHashlock(ctx, aCookie, hl1);
      expect((await createHashlock(ctx, aCookie, 'bob@test.com', 4n * ONE_RPOW, h2.hashHex)).statusCode).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. AUTH & PERMISSIONS
  // ═══════════════════════════════════════════════════════════════════

  describe('auth and permissions', () => {
    it('all mutating endpoints require auth', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const noAuth = { 'content-type': 'application/json' };

      expect((await ctx.app.inject({
        method: 'POST', url: '/hashlock', headers: noAuth,
        payload: { recipient_email: 'x@x.com', amount_base_units: '1', hash_h_hex: '00'.repeat(32), timeout_seconds: 3600, idempotency_key: randomUUID() },
      })).statusCode).toBe(401);

      expect((await ctx.app.inject({
        method: 'POST', url: `/hashlock/${randomUUID()}/claim`, headers: noAuth,
        payload: { preimage_hex: '00'.repeat(32) },
      })).statusCode).toBe(401);

      expect((await ctx.app.inject({
        method: 'POST', url: `/hashlock/${randomUUID()}/refund`, headers: noAuth,
      })).statusCode).toBe(401);
    });

    it('GET requires no auth', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));

      const res = await ctx.app.inject({ method: 'GET', url: `/hashlock/${lockId}` });
      expect(res.statusCode).toBe(200);
    });

    it('sender cannot claim own hashlock', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { preimageHex, hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));

      expect((await claimHashlock(ctx, aCookie, lockId, preimageHex)).statusCode).toBe(403);
    });

    it('recipient cannot refund', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));
      await expireHashlock(ctx, lockId);

      expect((await refundHashlock(ctx, bCookie, lockId)).statusCode).toBe(403);
    });

    it('third party cannot claim or refund', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      const cCookie = await loginAs(ctx, 'carol@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { preimageHex, hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));

      expect((await claimHashlock(ctx, cCookie, lockId, preimageHex)).statusCode).toBe(403);

      await expireHashlock(ctx, lockId);
      expect((await refundHashlock(ctx, cCookie, lockId)).statusCode).toBe(403);
    });

    it('cannot hashlock to self', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      const res = await createHashlock(ctx, aCookie, 'alice@test.com', ONE_RPOW, hashHex);
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('self');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 8. IDEMPOTENCY
  // ═══════════════════════════════════════════════════════════════════

  describe('idempotency', () => {
    it('same key + same params returns same hashlock, no double-lock', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 5n * ONE_RPOW);

      const { hashHex } = makePreimage();
      const idem = randomUUID();

      const r1 = await createHashlock(ctx, aCookie, 'bob@test.com', 2n * ONE_RPOW, hashHex, { idem });
      const r2 = await createHashlock(ctx, aCookie, 'bob@test.com', 2n * ONE_RPOW, hashHex, { idem });

      expect(r1.json().hashlock_id).toBe(r2.json().hashlock_id);
      expect(await getBalance(ctx, aCookie)).toBe(3n * ONE_RPOW);
    });

    it('same key + different recipient → 409', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await loginAs(ctx, 'carol@test.com');
      await seedToken(ctx, 'alice@test.com', 5n * ONE_RPOW);

      const { hashHex } = makePreimage();
      const idem = randomUUID();

      expect((await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex, { idem })).statusCode).toBe(200);
      expect((await createHashlock(ctx, aCookie, 'carol@test.com', ONE_RPOW, hashHex, { idem })).statusCode).toBe(409);
    });

    it('same key + different amount → 409', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 5n * ONE_RPOW);

      const { hashHex } = makePreimage();
      const idem = randomUUID();

      expect((await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex, { idem })).statusCode).toBe(200);
      expect((await createHashlock(ctx, aCookie, 'bob@test.com', 2n * ONE_RPOW, hashHex, { idem })).statusCode).toBe(409);
    });

    it('same key + different hash → 409', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 5n * ONE_RPOW);

      const h1 = makePreimage();
      const h2 = makePreimage();
      const idem = randomUUID();

      expect((await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, h1.hashHex, { idem })).statusCode).toBe(200);
      expect((await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, h2.hashHex, { idem })).statusCode).toBe(409);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 9. VALIDATION & ERROR CASES
  // ═══════════════════════════════════════════════════════════════════

  describe('validation', () => {
    it('rejects zero amount', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');

      const res = await ctx.app.inject({
        method: 'POST', url: '/hashlock',
        headers: { cookie: aCookie, 'content-type': 'application/json' },
        payload: { recipient_email: 'b@x.com', amount_base_units: '0', hash_h_hex: '00'.repeat(32), timeout_seconds: 3600, idempotency_key: randomUUID() },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects negative amount', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');

      const res = await ctx.app.inject({
        method: 'POST', url: '/hashlock',
        headers: { cookie: aCookie, 'content-type': 'application/json' },
        payload: { recipient_email: 'b@x.com', amount_base_units: '-1000000000', hash_h_hex: '00'.repeat(32), timeout_seconds: 3600, idempotency_key: randomUUID() },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid hash length', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');

      const res = await ctx.app.inject({
        method: 'POST', url: '/hashlock',
        headers: { cookie: aCookie, 'content-type': 'application/json' },
        payload: { recipient_email: 'b@x.com', amount_base_units: ONE_RPOW.toString(), hash_h_hex: 'abcd', timeout_seconds: 3600, idempotency_key: randomUUID() },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid preimage length', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));

      const res = await ctx.app.inject({
        method: 'POST', url: `/hashlock/${lockId}/claim`,
        headers: { cookie: bCookie, 'content-type': 'application/json' },
        payload: { preimage_hex: 'abcd' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects wrong preimage', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));

      const wrongPreimage = randomBytes(32).toString('hex');
      const res = await claimHashlock(ctx, bCookie, lockId, wrongPreimage);
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('preimage');
    });

    it('rejects insufficient balance', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      const res = await createHashlock(ctx, aCookie, 'bob@test.com', 2n * ONE_RPOW, hashHex);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
    });

    it('rejects with zero balance', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');

      const { hashHex } = makePreimage();
      const res = await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
    });

    it('404 for nonexistent hashlock (GET, claim, refund)', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');

      expect((await getHashlockState(ctx, randomUUID())).statusCode).toBe(404);
      expect((await claimHashlock(ctx, aCookie, randomUUID(), '00'.repeat(32))).statusCode).toBe(404);
      expect((await refundHashlock(ctx, aCookie, randomUUID())).statusCode).toBe(404);
    });

    it('rejects invalid recipient email', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');

      const res = await ctx.app.inject({
        method: 'POST', url: '/hashlock',
        headers: { cookie: aCookie, 'content-type': 'application/json' },
        payload: { recipient_email: 'not-an-email', amount_base_units: ONE_RPOW.toString(), hash_h_hex: '00'.repeat(32), timeout_seconds: 3600, idempotency_key: randomUUID() },
      });
      expect(res.statusCode).toBe(400);
    });

    it('recipient email is lowercased and trimmed', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { preimageHex, hashHex } = makePreimage();
      const lockRes = await createHashlock(ctx, aCookie, 'Bob@Test.COM', ONE_RPOW, hashHex);
      expect(lockRes.statusCode).toBe(200);
      expect(lockRes.json().recipient_email).toBe('bob@test.com');

      // Bob claims with his normal session.
      expect((await claimHashlock(ctx, bCookie, hlId(lockRes), preimageHex)).statusCode).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 10. SUPPLY INTEGRITY
  // ═══════════════════════════════════════════════════════════════════

  describe('supply integrity', () => {
    it('total VALID supply conserved across lock + claim', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 10n * ONE_RPOW);

      const totalBefore = await totalValidSupply(ctx);

      const { preimageHex, hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', 3n * ONE_RPOW, hashHex));

      // Mid-lock: VALID + HASHLOCKED = original.
      const midValid = await totalValidSupply(ctx);
      const midLocked = await totalHashlockedSupply(ctx);
      expect(midValid + midLocked).toBe(totalBefore);

      await claimHashlock(ctx, bCookie, lockId, preimageHex);
      expect(await totalValidSupply(ctx)).toBe(totalBefore);
    });

    it('total VALID supply conserved across lock + refund', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 10n * ONE_RPOW);

      const totalBefore = await totalValidSupply(ctx);

      const { hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', 5n * ONE_RPOW, hashHex));
      await expireHashlock(ctx, lockId);
      await refundHashlock(ctx, aCookie, lockId);

      expect(await totalValidSupply(ctx)).toBe(totalBefore);
    });

    it('complex: multiple locks, partial claims, partial refunds — supply unchanged', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      const cCookie = await loginAs(ctx, 'carol@test.com');
      await seedToken(ctx, 'alice@test.com', 20n * ONE_RPOW);

      const totalBefore = await totalValidSupply(ctx);

      const h1 = makePreimage();
      const h2 = makePreimage();
      const h3 = makePreimage();

      const hl1 = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', 3n * ONE_RPOW, h1.hashHex));
      const hl2 = hlId(await createHashlock(ctx, aCookie, 'carol@test.com', 5n * ONE_RPOW, h2.hashHex));
      const hl3 = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', 4n * ONE_RPOW, h3.hashHex));

      expect(await getBalance(ctx, aCookie)).toBe(8n * ONE_RPOW);

      // Claim hl1.
      await claimHashlock(ctx, bCookie, hl1, h1.preimageHex);
      expect(await getBalance(ctx, bCookie)).toBe(3n * ONE_RPOW);

      // Refund hl2.
      await expireHashlock(ctx, hl2);
      await refundHashlock(ctx, aCookie, hl2);
      expect(await getBalance(ctx, aCookie)).toBe(13n * ONE_RPOW);

      // Claim hl3.
      await claimHashlock(ctx, bCookie, hl3, h3.preimageHex);
      expect(await getBalance(ctx, bCookie)).toBe(7n * ONE_RPOW);

      // Alice=13, Bob=7, Carol=0 → Total=20 = original.
      const totalAfter = await totalValidSupply(ctx);
      expect(totalAfter).toBe(totalBefore);

      const sumAll =
        (await getBalance(ctx, aCookie)) +
        (await getBalance(ctx, bCookie)) +
        (await getBalance(ctx, cCookie));
      expect(sumAll).toBe(totalBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 11. CROSS-ROUTE ISOLATION — /send
  // ═══════════════════════════════════════════════════════════════════

  describe('cross-route isolation: /send', () => {
    it('/send cannot spend HASHLOCKED tokens', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      // Alice has exactly 2 RPOW.
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      // Lock all 2 RPOW.
      const { hashHex } = makePreimage();
      await createHashlock(ctx, aCookie, 'bob@test.com', 2n * ONE_RPOW, hashHex);
      expect(await getBalance(ctx, aCookie)).toBe(0n);

      // Try to /send — should fail, balance is 0.
      const sendRes = await ctx.app.inject({
        method: 'POST', url: '/send',
        headers: { cookie: aCookie, 'content-type': 'application/json' },
        payload: {
          recipient_email: 'bob@test.com',
          amount_base_units: '1',
          idempotency_key: randomUUID(),
        },
      });
      expect(sendRes.statusCode).toBe(400);
      expect(sendRes.json().error).toBe('INSUFFICIENT_BALANCE');
    });

    it('/send works with VALID tokens alongside HASHLOCKED ones', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 3n * ONE_RPOW);
      await seedToken(ctx, 'alice@test.com', 2n * ONE_RPOW);

      // Lock 3 RPOW, leaving 2 RPOW VALID.
      const { hashHex } = makePreimage();
      await createHashlock(ctx, aCookie, 'bob@test.com', 3n * ONE_RPOW, hashHex);

      // /send 1 RPOW should succeed from the remaining 2.
      const sendRes = await ctx.app.inject({
        method: 'POST', url: '/send',
        headers: { cookie: aCookie, 'content-type': 'application/json' },
        payload: {
          recipient_email: 'bob@test.com',
          amount_base_units: ONE_RPOW.toString(),
          idempotency_key: randomUUID(),
        },
      });
      expect(sendRes.statusCode).toBe(200);
      expect(await getBalance(ctx, aCookie)).toBe(ONE_RPOW);
    });

    it('/send cannot exceed VALID balance even when HASHLOCKED tokens exist', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 5n * ONE_RPOW);

      // Lock 3 RPOW, leaving 2 RPOW VALID.
      const { hashHex } = makePreimage();
      await createHashlock(ctx, aCookie, 'bob@test.com', 3n * ONE_RPOW, hashHex);

      // Try to send 3 RPOW — only 2 available.
      const sendRes = await ctx.app.inject({
        method: 'POST', url: '/send',
        headers: { cookie: aCookie, 'content-type': 'application/json' },
        payload: {
          recipient_email: 'bob@test.com',
          amount_base_units: (3n * ONE_RPOW).toString(),
          idempotency_key: randomUUID(),
        },
      });
      expect(sendRes.statusCode).toBe(400);
      expect(sendRes.json().error).toBe('INSUFFICIENT_BALANCE');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 12. /me DISPLAY — HASHLOCKED excluded from balance
  // ═══════════════════════════════════════════════════════════════════

  describe('/me balance display', () => {
    it('/me excludes HASHLOCKED tokens from balance_base_units', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 5n * ONE_RPOW);

      const { hashHex } = makePreimage();
      await createHashlock(ctx, aCookie, 'bob@test.com', 3n * ONE_RPOW, hashHex);

      const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
      expect(me.balance_base_units).toBe((2n * ONE_RPOW).toString());
    });

    it('/me shows 0 balance when all tokens are HASHLOCKED', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex);

      const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
      expect(me.balance_base_units).toBe('0');
    });

    it('/me balance restores after refund', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 5n * ONE_RPOW);

      const { hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', 3n * ONE_RPOW, hashHex));

      await expireHashlock(ctx, lockId);
      await refundHashlock(ctx, aCookie, lockId);

      const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: aCookie } })).json();
      expect(me.balance_base_units).toBe((5n * ONE_RPOW).toString());
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 13. CROSS-ROUTE ISOLATION — /srpow/wrap
  // ═══════════════════════════════════════════════════════════════════

  describe('cross-route isolation: /srpow/wrap', () => {
    it('/srpow/wrap cannot wrap HASHLOCKED tokens', async () => {
      const ctx = await makeTestApp({ wrapAllowlistCsv: 'alice@test.com' }); cleanup = ctx.cleanup;
      // Seed user with wallet + tokens.
      await seedUserWithWallet(ctx, 'alice@test.com', 'FAKEWALLET1', 3n * ONE_RPOW);
      await loginAs(ctx, 'bob@test.com');

      const session = signSession({ email: 'alice@test.com' }, 'x'.repeat(32), 60);

      // Lock all tokens.
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const { hashHex } = makePreimage();
      await createHashlock(ctx, aCookie, 'bob@test.com', 3n * ONE_RPOW, hashHex);

      // Try to wrap — should fail with INSUFFICIENT_BALANCE.
      const wrapRes = await ctx.app.inject({
        method: 'POST', url: '/srpow/wrap',
        cookies: { [SESSION_COOKIE]: session },
        payload: { amount_base_units: ONE_RPOW.toString(), idempotency_key: randomUUID() },
      });
      expect(wrapRes.statusCode).toBe(400);
      expect(wrapRes.json().error).toBe('INSUFFICIENT_BALANCE');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 14. API KEY AUTH PATH
  // ═══════════════════════════════════════════════════════════════════

  describe('API key auth', () => {
    it('create hashlock via API key', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const { plaintext } = await seedUserAndKey(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 5n * ONE_RPOW);

      const { hashHex } = makePreimage();
      const res = await ctx.app.inject({
        method: 'POST', url: '/hashlock',
        headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
        payload: {
          recipient_email: 'bob@test.com',
          amount_base_units: (2n * ONE_RPOW).toString(),
          hash_h_hex: hashHex,
          timeout_seconds: 3600,
          idempotency_key: randomUUID(),
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().state).toBe('PENDING');
    });

    it('claim hashlock via API key', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const { plaintext: bobKey } = await seedUserAndKey(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { preimageHex, hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));

      const claimRes = await ctx.app.inject({
        method: 'POST', url: `/hashlock/${lockId}/claim`,
        headers: { authorization: `Bearer ${bobKey}`, 'content-type': 'application/json' },
        payload: { preimage_hex: preimageHex },
      });
      expect(claimRes.statusCode).toBe(200);
      expect(claimRes.json().state).toBe('CLAIMED');
    });

    it('refund hashlock via API key', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const { plaintext: aliceKey } = await seedUserAndKey(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      const lockRes = await ctx.app.inject({
        method: 'POST', url: '/hashlock',
        headers: { authorization: `Bearer ${aliceKey}`, 'content-type': 'application/json' },
        payload: {
          recipient_email: 'bob@test.com',
          amount_base_units: ONE_RPOW.toString(),
          hash_h_hex: hashHex,
          timeout_seconds: 3600,
          idempotency_key: randomUUID(),
        },
      });
      const lockId = lockRes.json().hashlock_id;

      await expireHashlock(ctx, lockId);

      const refundRes = await ctx.app.inject({
        method: 'POST', url: `/hashlock/${lockId}/refund`,
        headers: { authorization: `Bearer ${aliceKey}`, 'content-type': 'application/json' },
      });
      expect(refundRes.statusCode).toBe(200);
      expect(refundRes.json().state).toBe('REFUNDED');
    });

    it('full lock→claim cycle via API keys only (bridge simulation)', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const { plaintext: aliceKey } = await seedUserAndKey(ctx, 'alice@test.com');
      const { plaintext: bobKey } = await seedUserAndKey(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 5n * ONE_RPOW);

      const { preimageHex, hashHex } = makePreimage();

      // Alice creates via API key.
      const lockRes = await ctx.app.inject({
        method: 'POST', url: '/hashlock',
        headers: { authorization: `Bearer ${aliceKey}`, 'content-type': 'application/json' },
        payload: {
          recipient_email: 'bob@test.com',
          amount_base_units: (3n * ONE_RPOW).toString(),
          hash_h_hex: hashHex,
          timeout_seconds: 3600,
          idempotency_key: randomUUID(),
        },
      });
      expect(lockRes.statusCode).toBe(200);
      const lockId = lockRes.json().hashlock_id;

      // Bob claims via API key.
      const claimRes = await ctx.app.inject({
        method: 'POST', url: `/hashlock/${lockId}/claim`,
        headers: { authorization: `Bearer ${bobKey}`, 'content-type': 'application/json' },
        payload: { preimage_hex: preimageHex },
      });
      expect(claimRes.statusCode).toBe(200);

      // Verify balances via API key.
      const aliceMe = (await ctx.app.inject({
        method: 'GET', url: '/me',
        headers: { authorization: `Bearer ${aliceKey}` },
      })).json();
      const bobMe = (await ctx.app.inject({
        method: 'GET', url: '/me',
        headers: { authorization: `Bearer ${bobKey}` },
      })).json();

      expect(aliceMe.balance_base_units).toBe((2n * ONE_RPOW).toString());
      expect(bobMe.balance_base_units).toBe((3n * ONE_RPOW).toString());
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 15. CHANGE TOKEN PROVENANCE
  // ═══════════════════════════════════════════════════════════════════

  describe('change token provenance', () => {
    it('change token has parent_token_id pointing to consumed token', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      const sourceTokenId = await seedToken(ctx, 'alice@test.com', 5n * ONE_RPOW);

      const { hashHex } = makePreimage();
      await createHashlock(ctx, aCookie, 'bob@test.com', 3n * ONE_RPOW, hashHex);

      // Change token should reference the consumed source token.
      const { rows } = await ctx.pool.query<{ id: string; parent_token_id: string | null; value: string }>(
        `SELECT id, parent_token_id::text, value::text AS value FROM tokens
         WHERE owner_email = 'alice@test.com' AND state = 'VALID'`,
      );
      expect(rows).toHaveLength(1);
      expect(BigInt(rows[0].value)).toBe(2n * ONE_RPOW);
      expect(rows[0].parent_token_id).toBe(sourceTokenId);
    });

    it('claimed recipient token has parent_token_id pointing to locked token', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      const bCookie = await loginAs(ctx, 'bob@test.com');
      const sourceTokenId = await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { preimageHex, hashHex } = makePreimage();
      const lockId = hlId(await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex));
      await claimHashlock(ctx, bCookie, lockId, preimageHex);

      const { rows } = await ctx.pool.query<{ parent_token_id: string | null }>(
        `SELECT parent_token_id::text FROM tokens
         WHERE owner_email = 'bob@test.com' AND state = 'VALID'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].parent_token_id).toBe(sourceTokenId);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 16. AMOUNT BOUNDARY VALIDATION
  // ═══════════════════════════════════════════════════════════════════

  describe('amount boundaries', () => {
    it('rejects amount > 10^18', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');

      const res = await ctx.app.inject({
        method: 'POST', url: '/hashlock',
        headers: { cookie: aCookie, 'content-type': 'application/json' },
        payload: {
          recipient_email: 'bob@test.com',
          amount_base_units: (10n ** 18n + 1n).toString(),
          hash_h_hex: '00'.repeat(32),
          timeout_seconds: 3600,
          idempotency_key: randomUUID(),
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('accepts exact 10^18', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', 10n ** 18n);

      const { hashHex } = makePreimage();
      const res = await createHashlock(ctx, aCookie, 'bob@test.com', 10n ** 18n, hashHex);
      expect(res.statusCode).toBe(200);
    });

    it('rejects non-numeric amount string', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');

      const res = await ctx.app.inject({
        method: 'POST', url: '/hashlock',
        headers: { cookie: aCookie, 'content-type': 'application/json' },
        payload: {
          recipient_email: 'bob@test.com',
          amount_base_units: 'abc',
          hash_h_hex: '00'.repeat(32),
          timeout_seconds: 3600,
          idempotency_key: randomUUID(),
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects leading-zero amount string', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');

      const res = await ctx.app.inject({
        method: 'POST', url: '/hashlock',
        headers: { cookie: aCookie, 'content-type': 'application/json' },
        payload: {
          recipient_email: 'bob@test.com',
          amount_base_units: '01000000000',
          hash_h_hex: '00'.repeat(32),
          timeout_seconds: 3600,
          idempotency_key: randomUUID(),
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 17. TIMEOUT BOUNDARY VALIDATION
  // ═══════════════════════════════════════════════════════════════════

  describe('timeout boundaries', () => {
    it('accepts minimum timeout (60 seconds)', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      const res = await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex, { timeout: 60 });
      expect(res.statusCode).toBe(200);
    });

    it('accepts maximum timeout (604800 seconds / 7 days)', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      const res = await createHashlock(ctx, aCookie, 'bob@test.com', ONE_RPOW, hashHex, { timeout: 604800 });
      expect(res.statusCode).toBe(200);
    });

    it('rejects timeout below minimum (59 seconds)', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');

      const res = await ctx.app.inject({
        method: 'POST', url: '/hashlock',
        headers: { cookie: aCookie, 'content-type': 'application/json' },
        payload: {
          recipient_email: 'bob@test.com',
          amount_base_units: ONE_RPOW.toString(),
          hash_h_hex: '00'.repeat(32),
          timeout_seconds: 59,
          idempotency_key: randomUUID(),
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects timeout above maximum (604801 seconds)', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');

      const res = await ctx.app.inject({
        method: 'POST', url: '/hashlock',
        headers: { cookie: aCookie, 'content-type': 'application/json' },
        payload: {
          recipient_email: 'bob@test.com',
          amount_base_units: ONE_RPOW.toString(),
          hash_h_hex: '00'.repeat(32),
          timeout_seconds: 604801,
          idempotency_key: randomUUID(),
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('uses default timeout (14400) when not specified', async () => {
      const ctx = await makeTestApp(); cleanup = ctx.cleanup;
      const aCookie = await loginAs(ctx, 'alice@test.com');
      await loginAs(ctx, 'bob@test.com');
      await seedToken(ctx, 'alice@test.com', ONE_RPOW);

      const { hashHex } = makePreimage();
      const res = await ctx.app.inject({
        method: 'POST', url: '/hashlock',
        headers: { cookie: aCookie, 'content-type': 'application/json' },
        payload: {
          recipient_email: 'bob@test.com',
          amount_base_units: ONE_RPOW.toString(),
          hash_h_hex: hashHex,
          idempotency_key: randomUUID(),
        },
      });
      expect(res.statusCode).toBe(200);
      const lockId = res.json().hashlock_id;

      // Verify expiry is ~4 hours from now.
      const { rows } = await ctx.pool.query<{ timeout_seconds: number }>(
        'SELECT timeout_seconds FROM hashlocked_transfers WHERE id = $1',
        [lockId],
      );
      expect(rows[0].timeout_seconds).toBe(14400);
    });
  });
});
