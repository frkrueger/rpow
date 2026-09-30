import type { FastifyInstance } from 'fastify';
import { randomUUID, randomBytes } from 'node:crypto';
import { readSession } from './auth.js';
import { difficultyBitsForSupply, BASE_UNITS_PER_RPOW } from '../schedule.js';

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
          `SELECT COALESCE(SUM(value), 0)::text AS value FROM app_counters WHERE name='minted_supply'`,
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

    // Single round-trip for both lookups: pending challenge (kind=1) and
    // most-recent claimed_at for the cooldown check (kind=2).
    //
    // Previously this whole handler ran inside withTx + pg_try_advisory_xact_lock
    // for per-user serialization. That cost 5 PG round-trips per /challenge
    // (BEGIN + lock + lookup + insert + COMMIT) and a global serialization
    // point. Dropping the lock + transaction is safe: duplicate pending
    // challenges from a parallel call are harmless because /mint atomically
    // validates against the daily cap + supply cap, and only one challenge can
    // be claimed per nonce. Two round-trips total now (lookup + insert).
    const { rows: lookup } = await app.pool.query<{
      kind: number;
      id: string | null;
      nonce_prefix: Buffer | null;
      difficulty_bits: number | null;
      expires_at: Date | null;
      claimed_at: Date | null;
    }>(
      `(SELECT 1 AS kind, id, nonce_prefix, difficulty_bits, expires_at, NULL::timestamptz AS claimed_at
          FROM challenges
          WHERE user_email=$1 AND claimed_at IS NULL AND expires_at > now()
          ORDER BY issued_at DESC LIMIT 1)
       UNION ALL
       (SELECT 2 AS kind, NULL::uuid, NULL::bytea, NULL::int, NULL::timestamptz, claimed_at
          FROM challenges
          WHERE user_email=$1 AND claimed_at IS NOT NULL
          ORDER BY claimed_at DESC LIMIT 1)`,
      [s.email],
    );
    const pending = lookup.find(r => r.kind === 1);
    const lastClaimed = lookup.find(r => r.kind === 2);
    if (pending) {
      return {
        challenge_id: pending.id!,
        nonce_prefix: pending.nonce_prefix!.toString('hex'),
        difficulty_bits: pending.difficulty_bits!,
        expires_at: pending.expires_at!.toISOString(),
      };
    }
    if (lastClaimed?.claimed_at && !isOperator) {
      const elapsedMs = Date.now() - lastClaimed.claimed_at.getTime();
      if (elapsedMs < 5000) {
        const wait = Math.ceil((5000 - elapsedMs) / 1000);
        return reply.code(429).send({ error: 'COOLDOWN', message: `wait ${wait}s before next challenge`, retry_after: wait });
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
    await app.pool.query(
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
}
