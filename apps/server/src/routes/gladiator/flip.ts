import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { readSession } from '../auth.js';
import { withTx } from '../../db.js';
import { burnFromUser } from '../../longshot/burn.js';
import { signTokenPayload, signFlipPayload, type FlipPayload } from '../../signing.js';
import { drawFlip } from '../../gladiator/randomness.js';

const BASE_UNITS_PER_RPOW = 1_000_000_000n;

function formatRpow(baseUnits: bigint): string {
  if (baseUnits % BASE_UNITS_PER_RPOW === 0n) {
    return (baseUnits / BASE_UNITS_PER_RPOW).toString();
  }
  return (Number(baseUnits) / 1e9).toFixed(9).replace(/\.?0+$/, '');
}

const FlipBody = z.object({
  session_id: z.string().uuid(),
});

const NOT_IMPLEMENTED = { error: 'NOT_IMPLEMENTED', message: 'gladiator slice 1' };

export async function flipRoutes(app: FastifyInstance) {
  app.post('/api/gladiator/flip', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (req: any) => req.headers['x-forwarded-for'] ?? req.ip,
      },
    },
  }, async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const challengerEmail = s.email;

    const challengerRes = await app.pool.query<{
      x_handle: string | null;
      x_handle_verified_at: Date | null;
    }>(
      `SELECT x_handle, x_handle_verified_at FROM users WHERE email = $1`,
      [challengerEmail],
    );
    const challenger = challengerRes.rows[0];
    if (!challenger || !challenger.x_handle_verified_at || !challenger.x_handle) {
      return reply.code(403).send({ error: 'X_HANDLE_REQUIRED', message: 'X handle verification required' });
    }
    const challengerHandle = challenger.x_handle;

    const parsed = FlipBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }
    const sessionId = parsed.data.session_id;

    type FlipResult =
      | {
          ok: true;
          flipId: string;
          offererEmail: string;
          offererHandle: string;
          bet: bigint;
          winnerEmail: string;
          rvHex: string;
          signature: Buffer;
          bankrollRemaining: bigint;
          sessionStatus: 'OPEN' | 'CLOSED';
          closedAt: Date | null;
          createdAt: Date;
        }
      | { error: string; message: string; status: number };

    let result: FlipResult;
    try {
      result = await withTx<FlipResult>(app.pool, async (c) => {
        const sessRes = await c.query<{
          id: string;
          account_email: string;
          bet_base_units: string;
          bankroll_remaining_base_units: string;
          status: string;
        }>(
          `SELECT id, account_email, bet_base_units::text, bankroll_remaining_base_units::text, status
           FROM gladiator_sessions
           WHERE id = $1
           FOR UPDATE`,
          [sessionId],
        );
        if (sessRes.rows.length === 0) {
          return { error: 'SESSION_NOT_FOUND', message: 'session not found', status: 404 };
        }
        const sess = sessRes.rows[0];

        if (sess.account_email === challengerEmail) {
          return { error: 'SELF_CHALLENGE', message: 'cannot challenge your own session', status: 400 };
        }

        const bet = BigInt(sess.bet_base_units);
        const bankroll = BigInt(sess.bankroll_remaining_base_units);
        if (sess.status !== 'OPEN' || bankroll < bet) {
          return { error: 'OFFER_UNAVAILABLE', message: 'session not open or bankroll insufficient', status: 409 };
        }

        const offererEmail = sess.account_email;

        const offererRes = await c.query<{ x_handle: string | null }>(
          `SELECT x_handle FROM users WHERE email = $1`,
          [offererEmail],
        );
        const offererHandle = offererRes.rows[0]?.x_handle ?? offererEmail;

        await burnFromUser(c, challengerEmail, bet, app.config.signingPrivateKeyHex);

        await c.query(
          `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply'`,
          [bet.toString()],
        );

        const { challengerWins, hex: rvHex } = drawFlip();
        const winnerEmail = challengerWins ? challengerEmail : offererEmail;

        let newBankroll: bigint;
        if (challengerWins) {
          newBankroll = bankroll - bet;
          await c.query(
            `UPDATE gladiator_sessions
             SET bankroll_remaining_base_units = $1::bigint,
                 flips_lost = flips_lost + 1,
                 last_flip_at = now()
             WHERE id = $2`,
            [newBankroll.toString(), sessionId],
          );

          const payout = bet * 2n;
          const capBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;
          const supplyResult = await c.query(
            `UPDATE app_counters SET value = value + $1::bigint
             WHERE name = 'minted_supply' AND value + $1::bigint <= $2::bigint`,
            [payout.toString(), capBaseUnits.toString()],
          );
          if ((supplyResult.rowCount ?? 0) === 0) {
            return { error: 'SUPPLY_CAP_REACHED', message: 'minted supply cap reached', status: 503 };
          }

          const tokenId = randomUUID();
          const issuedAt = new Date();
          const ownerEmailHash = createHash('sha256').update(challengerEmail).digest('hex');
          const sig = signTokenPayload(
            { id: tokenId, owner_email_hash: ownerEmailHash, value: payout, issued_at: issuedAt.toISOString() },
            app.config.signingPrivateKeyHex,
          );
          await c.query(
            `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
             VALUES($1, $2, $3, 'VALID', $4, $5)`,
            [tokenId, challengerEmail, payout.toString(), issuedAt, sig],
          );
        } else {
          newBankroll = bankroll + bet;
          await c.query(
            `UPDATE gladiator_sessions
             SET bankroll_remaining_base_units = $1::bigint,
                 flips_won = flips_won + 1,
                 last_flip_at = now()
             WHERE id = $2`,
            [newBankroll.toString(), sessionId],
          );
        }

        let sessionStatus: 'OPEN' | 'CLOSED' = 'OPEN';
        let closedAt: Date | null = null;
        if (newBankroll < bet) {
          if (newBankroll > 0n) {
            const capBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;
            const supplyResult = await c.query(
              `UPDATE app_counters SET value = value + $1::bigint
               WHERE name = 'minted_supply' AND value + $1::bigint <= $2::bigint`,
              [newBankroll.toString(), capBaseUnits.toString()],
            );
            if ((supplyResult.rowCount ?? 0) === 0) {
              return { error: 'SUPPLY_CAP_REACHED', message: 'minted supply cap reached', status: 503 };
            }
            const tokenId = randomUUID();
            const issuedAt = new Date();
            const ownerEmailHash = createHash('sha256').update(offererEmail).digest('hex');
            const sig = signTokenPayload(
              { id: tokenId, owner_email_hash: ownerEmailHash, value: newBankroll, issued_at: issuedAt.toISOString() },
              app.config.signingPrivateKeyHex,
            );
            await c.query(
              `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
               VALUES($1, $2, $3, 'VALID', $4, $5)`,
              [tokenId, offererEmail, newBankroll.toString(), issuedAt, sig],
            );
          }
          const closeRes = await c.query<{ closed_at: Date }>(
            `UPDATE gladiator_sessions
             SET status = 'CLOSED', closed_at = now()
             WHERE id = $1
             RETURNING closed_at`,
            [sessionId],
          );
          sessionStatus = 'CLOSED';
          closedAt = closeRes.rows[0].closed_at;

          await c.query(
            `INSERT INTO gladiator_chat_messages (id, account_email, x_handle, kind, body)
             VALUES ($1, NULL, NULL, 'SYSTEM', $2)`,
            [randomUUID(), `@${offererHandle} drained out of the arena`],
          );
        }

        const flipId = randomUUID();
        const createdAt = new Date();
        const flipPayload: FlipPayload = {
          id: flipId,
          offerer_email_hash: createHash('sha256').update(offererEmail).digest('hex'),
          challenger_email_hash: createHash('sha256').update(challengerEmail).digest('hex'),
          bet_base_units: bet,
          winner_email_hash: createHash('sha256').update(winnerEmail).digest('hex'),
          random_value_hex: rvHex,
          created_at: createdAt.toISOString(),
        };
        const signature = signFlipPayload(flipPayload, app.config.signingPrivateKeyHex);
        await c.query(
          `INSERT INTO gladiator_flips
             (id, offerer_session_id, challenger_session_id, offerer_email, challenger_email,
              bet_base_units, winner_email, random_value_hex, signature, created_at)
           VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9)`,
          [flipId, sessionId, offererEmail, challengerEmail, bet.toString(), winnerEmail, rvHex, signature, createdAt],
        );

        const winnerHandle = challengerWins ? challengerHandle : offererHandle;
        const loserHandle = challengerWins ? offererHandle : challengerHandle;
        await c.query(
          `INSERT INTO gladiator_chat_messages (id, account_email, x_handle, kind, body)
           VALUES ($1, NULL, NULL, 'SYSTEM', $2)`,
          [randomUUID(), `@${winnerHandle} beat @${loserHandle} for ${formatRpow(bet * 2n)} RPOW`],
        );

        return {
          ok: true,
          flipId,
          offererEmail,
          offererHandle,
          bet,
          winnerEmail,
          rvHex,
          signature,
          bankrollRemaining: newBankroll,
          sessionStatus,
          closedAt,
          createdAt,
        };
      });
    } catch (e: any) {
      if (e?.message === 'INSUFFICIENT_BALANCE') {
        return reply.code(409).send({ error: 'INSUFFICIENT_BALANCE', message: 'not enough tokens' });
      }
      throw e;
    }

    if ('error' in result) {
      return reply.code(result.status).send({ error: result.error, message: result.message });
    }

    const winnerHandle =
      result.winnerEmail === challengerEmail ? challengerHandle : result.offererHandle;
    const opponentHandle =
      result.winnerEmail === challengerEmail ? result.offererHandle : challengerHandle;
    const shareText =
      `I just won ${formatRpow(result.bet * 2n)} RPOW in the gladiator arena against @${opponentHandle}.` +
      ` Come fight me at gladiator.rpow2.com`;

    return reply.code(200).send({
      flip_id: result.flipId,
      winner_email: result.winnerEmail,
      winner_x_handle: winnerHandle,
      bet_base_units: result.bet.toString(),
      random_value_hex: result.rvHex,
      signature: result.signature.toString('hex'),
      server_time: result.createdAt.toISOString(),
      share_text: shareText,
      session_status: result.sessionStatus,
      bankroll_remaining_base_units: result.bankrollRemaining.toString(),
      closed_at: result.closedAt ? result.closedAt.toISOString() : null,
    });
  });

  app.get('/api/gladiator/flips/recent', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.get('/api/gladiator/flips/history', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
}
