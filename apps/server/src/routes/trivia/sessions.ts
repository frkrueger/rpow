import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { readSession } from '../auth.js';
import { withTx } from '../../db.js';
import { burnFromUser } from '../../longshot/burn.js';
import { signTokenPayload } from '../../signing.js';
import { pickSupplyShard } from '../../supplyShards.js';

const BASE_UNITS_PER_RPOW = 1_000_000_000n;

/**
 * CSV allowlist check. '*' means everyone is allowed. Case-insensitive.
 * Mirrors apps/server/src/routes/longshot.ts.
 */
function isAllowed(allowlistCsv: string, email: string): boolean {
  const trimmed = allowlistCsv.trim();
  if (trimmed === '*') return true;
  const emailLower = email.toLowerCase();
  return trimmed
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .includes(emailLower);
}

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

const EnterBody = z.object({
  bankroll_base_units: z.string().regex(/^\d+$/, 'must be a non-negative integer string'),
  bet_base_units: z.string().regex(/^\d+$/, 'must be a non-negative integer string'),
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function sessionsRoutes(app: FastifyInstance) {
  // --------------------------------------------------------------------------
  // POST /api/trivia/sessions — Enter the arena
  // --------------------------------------------------------------------------
  app.post('/api/trivia/sessions', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
        keyGenerator: (req: any) => req.headers['x-forwarded-for'] ?? req.ip,
      },
    },
  }, async (req, reply) => {
    // 1. Auth
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const email = s.email;

    // 1b. Allowlist check
    if (!isAllowed(app.config.triviaAllowedEmails, email)) {
      return reply.code(403).send({ error: 'NOT_ALLOWED', message: 'trivia access required' });
    }

    // 2. Check X handle verified
    const userRes = await app.pool.query<{
      x_handle: string | null;
      x_handle_verified_at: Date | null;
    }>(
      `SELECT x_handle, x_handle_verified_at FROM users WHERE email = $1`,
      [email],
    );
    const user = userRes.rows[0];
    if (!user || !user.x_handle_verified_at) {
      return reply.code(403).send({ error: 'X_HANDLE_REQUIRED', message: 'X handle verification required' });
    }

    // 3. Parse + validate body
    const parsed = EnterBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }

    const bet = BigInt(parsed.data.bet_base_units);
    const bankroll = BigInt(parsed.data.bankroll_base_units);

    const minBet = BigInt(app.config.triviaMinBetBaseUnits);
    const maxBet = BigInt(app.config.triviaMaxBetBaseUnits);
    const maxBankroll = BigInt(app.config.triviaMaxBankrollBaseUnits);

    // 4. Validate bet range
    if (bet < minBet || bet > maxBet) {
      return reply.code(400).send({ error: 'STAKE_OUT_OF_RANGE', message: `bet must be between ${minBet} and ${maxBet} base units` });
    }

    // 5. Validate bankroll range: [bet, maxBankroll]
    if (bankroll < bet || bankroll > maxBankroll) {
      return reply.code(400).send({ error: 'BANKROLL_OUT_OF_RANGE', message: `bankroll must be between bet and ${maxBankroll} base units` });
    }

    // 6. Validate bankroll is a multiple of bet
    if (bankroll % bet !== 0n) {
      return reply.code(400).send({ error: 'BANKROLL_NOT_MULTIPLE', message: 'bankroll must be a clean multiple of bet' });
    }

    // 7. Transactional work
    const sessionId = randomUUID();

    type EnterResult =
      | { ok: true; bet_base_units: bigint; bankroll_initial_base_units: bigint; bankroll_remaining_base_units: bigint; status: string; opened_at: Date }
      | { error: string; message: string; status: number };

    let result: EnterResult;
    try {
      result = await withTx<EnterResult>(app.pool, async (c) => {
        // Burn bankroll from user's tokens, then mirror minted_supply.
        await burnFromUser(c, email, bankroll, app.config.signingPrivateKeyHex);
        await c.query(
          `UPDATE app_counters SET value = value - $1::bigint
           WHERE name = 'minted_supply' AND shard = $2`,
          [bankroll.toString(), pickSupplyShard()],
        );

        // Insert trivia session
        const insertRes = await c.query<{
          id: string;
          bet_base_units: string;
          bankroll_initial_base_units: string;
          bankroll_remaining_base_units: string;
          status: string;
          opened_at: Date;
        }>(
          `INSERT INTO trivia_sessions
             (id, account_email, bet_base_units, bankroll_initial_base_units, bankroll_remaining_base_units, status, opened_at)
           VALUES ($1, $2, $3, $4, $5, 'OPEN', now())
           RETURNING id, bet_base_units::text, bankroll_initial_base_units::text, bankroll_remaining_base_units::text, status, opened_at`,
          [sessionId, email, bet.toString(), bankroll.toString(), bankroll.toString()],
        );

        const row = insertRes.rows[0];

        return {
          ok: true,
          bet_base_units: BigInt(row.bet_base_units),
          bankroll_initial_base_units: BigInt(row.bankroll_initial_base_units),
          bankroll_remaining_base_units: BigInt(row.bankroll_remaining_base_units),
          status: row.status,
          opened_at: row.opened_at,
        };
      });
    } catch (e: any) {
      if (e?.message === 'INSUFFICIENT_BALANCE') {
        return reply.code(409).send({ error: 'INSUFFICIENT_BALANCE', message: 'not enough tokens' });
      }
      // Partial unique index conflict: one open session per user
      if (e?.code === '23505') {
        return reply.code(409).send({ error: 'SESSION_ALREADY_OPEN', message: 'you already have an open session' });
      }
      throw e;
    }

    if ('error' in result) {
      return reply.code(result.status).send({ error: result.error, message: result.message });
    }

    return reply.code(200).send({
      session_id: sessionId,
      bet_base_units: result.bet_base_units.toString(),
      bankroll_initial_base_units: result.bankroll_initial_base_units.toString(),
      bankroll_remaining_base_units: result.bankroll_remaining_base_units.toString(),
      status: result.status,
      opened_at: result.opened_at.toISOString(),
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/trivia/sessions/:id/close — Leave the arena
  // --------------------------------------------------------------------------
  app.post('/api/trivia/sessions/:id/close', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (req: any) => req.headers['x-forwarded-for'] ?? req.ip,
      },
    },
  }, async (req, reply) => {
    // 1. Auth
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const email = s.email;
    const { id: sessionId } = req.params as { id: string };

    type CloseResult =
      | { ok: true; closed_at: Date; refunded_base_units: bigint }
      | { error: string; message: string; status: number };

    let result: CloseResult;
    try {
      result = await withTx<CloseResult>(app.pool, async (c) => {
        // Lock the session row
        const sessionRes = await c.query<{
          id: string;
          account_email: string;
          bankroll_remaining_base_units: string;
          status: string;
        }>(
          `SELECT id, account_email, bankroll_remaining_base_units::text, status
           FROM trivia_sessions
           WHERE id = $1
           FOR UPDATE`,
          [sessionId],
        );

        if (sessionRes.rows.length === 0) {
          return { error: 'SESSION_NOT_FOUND', message: 'session not found', status: 404 };
        }

        const session = sessionRes.rows[0];

        // Ownership check
        if (session.account_email !== email) {
          return { error: 'FORBIDDEN', message: 'you do not own this session', status: 403 };
        }

        // Status check
        if (session.status !== 'OPEN') {
          return { error: 'SESSION_NOT_OPEN', message: 'session is not open', status: 409 };
        }

        const remaining = BigInt(session.bankroll_remaining_base_units);

        // Mint back remaining bankroll if > 0
        if (remaining > 0n) {
          const capBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;

          // Defensive cap check (should never fire since we burned this exact amount)
          const supplyResult = await c.query(
            `UPDATE app_counters SET value = value + $1::bigint
             WHERE name = 'minted_supply' AND shard = $3
               AND (SELECT COALESCE(SUM(value), 0) FROM app_counters WHERE name = 'minted_supply')
                   + $1::bigint <= $2::bigint`,
            [remaining.toString(), capBaseUnits.toString(), pickSupplyShard()],
          );
          if ((supplyResult.rowCount ?? 0) === 0) {
            throw new Error('SUPPLY_CAP_REACHED');
          }

          // Mint the refund token
          const tokenId = randomUUID();
          const issuedAt = new Date();
          const ownerEmailHash = createHash('sha256').update(email).digest('hex');
          const sig = signTokenPayload(
            { id: tokenId, owner_email_hash: ownerEmailHash, value: remaining, issued_at: issuedAt.toISOString() },
            app.config.signingPrivateKeyHex,
          );
          await c.query(
            `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
             VALUES($1, $2, $3, 'VALID', $4, $5)`,
            [tokenId, email, remaining.toString(), issuedAt, sig],
          );
        }

        // Close the session
        const closeRes = await c.query<{ closed_at: Date }>(
          `UPDATE trivia_sessions
           SET status = 'CLOSED', closed_at = now()
           WHERE id = $1
           RETURNING closed_at`,
          [sessionId],
        );

        const closedAt = closeRes.rows[0].closed_at;

        return { ok: true, closed_at: closedAt, refunded_base_units: remaining };
      });
    } catch (e: any) {
      if (e?.message === 'SUPPLY_CAP_REACHED') {
        return reply.code(503).send({ error: 'SUPPLY_CAP_REACHED', message: 'minted supply cap reached' });
      }
      throw e;
    }

    if ('error' in result) {
      return reply.code(result.status).send({ error: result.error, message: result.message });
    }

    return reply.code(200).send({
      status: 'CLOSED',
      closed_at: result.closed_at.toISOString(),
      refunded_base_units: result.refunded_base_units.toString(),
    });
  });
}
