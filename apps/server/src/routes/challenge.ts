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

    // Don't issue a new challenge if this user already has an unsolved one.
    const { rows: pending } = await app.pool.query<{ id: string; expires_at: Date }>(
      `SELECT id, expires_at FROM challenges
       WHERE user_email=$1 AND claimed_at IS NULL AND expires_at > now()
       ORDER BY issued_at DESC LIMIT 1`,
      [s.email],
    );
    if (pending[0]) {
      return reply.code(429).send({
        error: 'CHALLENGE_PENDING',
        message: 'solve or wait for your current challenge to expire',
        challenge_id: pending[0].id,
        expires_at: pending[0].expires_at.toISOString(),
      });
    }

    const minted = await mintedSupplyBaseUnits();
    const capBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;
    if (minted >= capBaseUnits) {
      return reply.code(410).send({ error: 'SUPPLY_EXHAUSTED', message: '21M cap reached' });
    }

    const scheduledBits = difficultyBitsForSupply(minted, {
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
