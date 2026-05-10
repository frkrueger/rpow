import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { readSession } from './auth.js';
import { verifySolution } from '../pow.js';
import { signTokenPayload } from '../signing.js';
import { withTx } from '../db.js';
import { currentRewardBaseUnits, BASE_UNITS_PER_RPOW } from '../schedule.js';

const Body = z.object({ challenge_id: z.string().uuid(), solution_nonce: z.string().regex(/^\d{1,20}$/) });

// Per-account per-UTC-day mint cap = (current reward) * SOLUTIONS_PER_DAY_PER_HUMAN.
// At ~1.2 sol/sec sustained this is comfortably above an active laptop miner;
// at 100x GPU speed a rig fills the bucket in ~15 minutes and idles until UTC
// midnight, which is the whole point.
const SOLUTIONS_PER_DAY_PER_HUMAN = 100_000n;

export async function mintRoutes(app: FastifyInstance) {
  // Per-IP rate limit: 10 mints/IP/minute per worker. With 4 workers the real
  // ceiling is ~40 mints/IP/min. This is a backstop against scripted /mint
  // floods from a single IP — the per-account daily cap is the primary
  // anti-GPU lever, this just makes the cap harder to fill in a burst.
  app.post(
    '/mint',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });

    const result = await withTx(app.pool, async (c) => {
      // Lock the challenge row and atomically claim it if eligible — one
      // round-trip instead of SELECT FOR UPDATE + UPDATE. The CTE always
      // returns the target row (when it exists) so we can distinguish
      // unknown/already-claimed/expired/just-claimed cases by inspecting
      // claimed_at vs the boolean `just_claimed` flag.
      const { rows } = await c.query<{
        id: string;
        nonce_prefix: Buffer;
        difficulty_bits: number;
        expires_at: Date;
        claimed_at: Date | null;
        just_claimed: boolean;
      }>(
        `WITH target AS (
           SELECT id, nonce_prefix, difficulty_bits, expires_at, claimed_at
           FROM challenges WHERE id=$1 AND user_email=$2 FOR UPDATE
         ),
         upd AS (
           UPDATE challenges SET claimed_at=now()
           WHERE id IN (SELECT id FROM target WHERE claimed_at IS NULL AND expires_at > now())
           RETURNING id
         )
         SELECT t.id, t.nonce_prefix, t.difficulty_bits, t.expires_at, t.claimed_at,
                EXISTS (SELECT 1 FROM upd) AS just_claimed
         FROM target t`,
        [parsed.data.challenge_id, s.email],
      );
      const ch = rows[0];
      if (!ch) return { error: 'BAD_REQUEST' as const, message: 'unknown challenge' };
      if (!ch.just_claimed) {
        // Row exists but we did not claim it — either someone else already did,
        // or it expired.
        if (ch.claimed_at) return { error: 'CHALLENGE_ALREADY_CLAIMED' as const, message: 'already claimed' };
        return { error: 'CHALLENGE_EXPIRED' as const, message: 'expired' };
      }

      const nonce = BigInt(parsed.data.solution_nonce);
      if (!verifySolution(ch.nonce_prefix, nonce, ch.difficulty_bits)) {
        return { error: 'INVALID_SOLUTION' as const, message: 'hash does not meet difficulty' };
      }

      const tokenId = randomUUID();
      const issuedAt = new Date();
      const ownerHash = createHash('sha256').update(s.email).digest('hex');

      // Lock the counter row, compute reward, increment, and insert token
      // in one serialized block to prevent stale reward at halving boundaries.
      const { rows: counterRows } = await c.query<{ value: string }>(
        `SELECT value::text FROM app_counters WHERE name='minted_supply' FOR UPDATE`,
      );
      const mintedBaseUnits = counterRows[0] ? BigInt(counterRows[0].value) : 0n;

      const reward = currentRewardBaseUnits(mintedBaseUnits, {
        maxSupplyRpow: app.config.mintMaxSupply,
      });
      if (reward === 0n) {
        return { error: 'SUPPLY_EXHAUSTED' as const, message: 'mining cap reached or reward floored' };
      }

      // Per-account daily cap: scales with current reward so it shrinks at
      // each halving. Single-statement UPSERT — insert with the reward on
      // first mint of the day, otherwise conditionally increment if under cap.
      // RETURNING is empty when the WHERE on conflict fails (cap reached).
      const dailyCap = reward * SOLUTIONS_PER_DAY_PER_HUMAN;
      const todayUtc = new Date().toISOString().slice(0, 10);
      const bucketResult = await c.query(
        `INSERT INTO daily_mint_buckets(email, day_utc, total_base_units)
         VALUES($1, $2, $3::bigint)
         ON CONFLICT (email, day_utc) DO UPDATE
           SET total_base_units = daily_mint_buckets.total_base_units + EXCLUDED.total_base_units
           WHERE daily_mint_buckets.total_base_units + EXCLUDED.total_base_units <= $4::bigint
         RETURNING total_base_units`,
        [s.email, todayUtc, reward.toString(), dailyCap.toString()],
      );
      if (bucketResult.rowCount === 0) {
        return {
          error: 'DAILY_CAP_REACHED' as const,
          message: 'daily mint quota reached for this account; resets at UTC midnight',
        };
      }

      // Combine the global-supply counter update with the token insert in one
      // round-trip. If the counter update returns no rows (cap exceeded), the
      // dependent INSERT inserts zero rows and we report SUPPLY_EXHAUSTED.
      const capBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;
      const sig = signTokenPayload(
        { id: tokenId, owner_email_hash: ownerHash, value: reward, issued_at: issuedAt.toISOString() },
        app.config.signingPrivateKeyHex,
      );
      const mintResult = await c.query(
        `WITH inc AS (
           UPDATE app_counters SET value = value + $2::bigint
           WHERE name='minted_supply' AND value + $2::bigint <= $1::bigint
           RETURNING 1
         )
         INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
         SELECT $3, $4, $5::bigint, 'VALID', $6, $7 FROM inc
         RETURNING id`,
        [capBaseUnits.toString(), reward.toString(), tokenId, s.email, reward.toString(), issuedAt, sig],
      );
      if (mintResult.rowCount === 0) {
        return { error: 'SUPPLY_EXHAUSTED' as const, message: 'mining cap reached' };
      }
      return { token: { id: tokenId, value_base_units: reward.toString(), issued_at: issuedAt.toISOString() } };
    });

    if ('error' in result) {
      let status: number;
      if (result.error === 'CHALLENGE_EXPIRED' || result.error === 'SUPPLY_EXHAUSTED') status = 410;
      else if (result.error === 'DAILY_CAP_REACHED') status = 429;
      else status = 400;
      return reply.code(status).send(result);
    }
    return result;
  });
}
