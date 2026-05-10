import type { FastifyInstance } from 'fastify';
import { randomUUID, randomBytes } from 'node:crypto';
import { readSession } from './auth.js';
import { difficultyBitsForSupply, BASE_UNITS_PER_RPOW } from '../schedule.js';
import { withTx } from '../db.js';

// Supply count is checked twice per mining round: here at /challenge
// (advisory only — used to pick difficulty and fail-fast at cap) and again
// inside /mint under an advisory lock (authoritative). At 30+ /challenge
// per second this count(*) was repeatedly scanning a half-million-row
// tokens table. Cache for 5s; the cap check is harmless to be slightly
// stale because /mint re-checks under the lock.
const SUPPLY_CACHE_MS = 5_000;

export async function challengeRoutes(app: FastifyInstance) {
  let supplyCache: { ts: number; value: bigint } | null = null;
  let supplyInflight: Promise<bigint> | null = null;

  async function mintedSupplyBaseUnits(): Promise<bigint> {
    if (supplyCache && Date.now() - supplyCache.ts < SUPPLY_CACHE_MS) return supplyCache.value;
    if (supplyInflight) return supplyInflight;
    supplyInflight = (async () => {
      try {
        const { rows } = await app.pool.query<{ value: string }>(
          `SELECT value::text FROM app_counters WHERE name='minted_supply'`,
        );
        const value = rows[0] ? BigInt(rows[0].value) : 0n;
        supplyCache = { ts: Date.now(), value };
        return value;
      } finally {
        supplyInflight = null;
      }
    })();
    return supplyInflight;
  }

  app.post('/challenge', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const isOperator = app.config.operatorEmails.has(s.email);

    // Read supply BEFORE entering withTx. mintedSupplyBaseUnits uses
    // app.pool.query (a fresh checkout). If called inside withTx while every
    // per-worker pool slot is already inside withTx, the supply query waits
    // for an 11th connection that can't exist — classic intra-pool deadlock.
    // Hoisting out also means the cap check stays read-only and advisory
    // (/mint re-checks under its own authoritative lock).
    const mintedPre = await mintedSupplyBaseUnits();
    const capBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;
    if (mintedPre >= capBaseUnits) {
      return reply.code(410).send({ error: 'SUPPLY_EXHAUSTED', message: '21M cap reached' });
    }

    // Serialize per-user with advisory lock to prevent concurrent challenge spam.
    // Use the non-blocking try variant: if a concurrent /challenge from the same
    // user already holds the lock, fail fast with 429 instead of stalling a
    // connection. Legit users only ever have one in-flight call so they never
    // hit this path; bots that fan-out parallel calls per account get rejected
    // immediately, freeing pg pool slots for everyone else.
    // Operator accounts bypass the lock entirely.
    const result = await withTx(app.pool, async (c) => {
      if (!isOperator) {
        const { rows: lock } = await c.query<{ ok: boolean }>(
          `SELECT pg_try_advisory_xact_lock(hashtext('rpow_challenge'), hashtext($1)) AS ok`,
          [s.email],
        );
        if (!lock[0]?.ok) return { _busy: true as const };
      }

      const { rows: pending } = await c.query<{ id: string; nonce_prefix: Buffer; difficulty_bits: number; expires_at: Date }>(
        `SELECT id, nonce_prefix, difficulty_bits, expires_at FROM challenges
         WHERE user_email=$1 AND claimed_at IS NULL AND expires_at > now()
         ORDER BY issued_at DESC LIMIT 1`,
        [s.email],
      );
      if (pending[0]) {
        return {
          challenge_id: pending[0].id,
          nonce_prefix: pending[0].nonce_prefix.toString('hex'),
          difficulty_bits: pending[0].difficulty_bits,
          expires_at: pending[0].expires_at.toISOString(),
        };
      }

      const { rows: lastClaimed } = await c.query<{ claimed_at: Date }>(
        `SELECT claimed_at FROM challenges
         WHERE user_email=$1 AND claimed_at IS NOT NULL
         ORDER BY claimed_at DESC LIMIT 1`,
        [s.email],
      );
      if (lastClaimed[0] && !isOperator) {
        const elapsedMs = Date.now() - lastClaimed[0].claimed_at.getTime();
        if (elapsedMs < 5000) {
          const wait = Math.ceil((5000 - elapsedMs) / 1000);
          return { _cooldown: true as const, wait };
        }
      }

      const scheduledBits = difficultyBitsForSupply(mintedPre, {
        difficultyBits: app.config.difficultyBits,
        maxSupplyRpow: app.config.mintMaxSupply,
      });
      const difficulty = Math.max(app.config.difficultyFloor, scheduledBits);

      const id = randomUUID();
      const noncePrefix = randomBytes(16);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      await c.query(
        'INSERT INTO challenges(id, user_email, nonce_prefix, difficulty_bits, expires_at) VALUES($1,$2,$3,$4,$5)',
        [id, s.email, noncePrefix, difficulty, expiresAt],
      );
      return {
        challenge_id: id,
        nonce_prefix: noncePrefix.toString('hex'),
        difficulty_bits: difficulty,
        expires_at: expiresAt.toISOString(),
      };
    });

    if ('_busy' in result) {
      return reply.code(429).send({ error: 'BUSY', message: 'another challenge is in flight for this account', retry_after: 1 });
    }
    if ('_cooldown' in result) {
      return reply.code(429).send({ error: 'COOLDOWN', message: `wait ${result.wait}s before next challenge`, retry_after: result.wait });
    }
    return result;
  });
}
