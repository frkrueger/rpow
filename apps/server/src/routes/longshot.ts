import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { readSession } from './auth.js';
import { withTx } from '../db.js';
import { signTokenPayload } from '../signing.js';
import { isValidOddsChoice, winProbabilityFor, payoutMultipleFor } from '../longshot/odds.js';
import * as randomness from '../longshot/randomness.js';
import { burnFromUser } from '../longshot/burn.js';

const BASE_UNITS_PER_RPOW = 1_000_000_000n;

/**
 * Returns true if email is allowed based on the allowlist CSV.
 * '*' means everyone is allowed.
 * Comparison is case-insensitive.
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

const SpinBody = z.object({
  stake_base_units: z.string().regex(/^\d+$/, 'must be a non-negative integer string'),
  odds_choice: z.string(),
});

export async function longshotRoutes(app: FastifyInstance) {
  app.get('/api/longshot/access', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const access = isAllowed(app.config.longShotAllowedEmails, s.email) ? 'allowed' : 'denied';
    return { access };
  });

  app.post('/api/longshot/spin', {
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

    if (!isAllowed(app.config.longShotAllowedEmails, s.email)) {
      return reply.code(403).send({ error: 'NOT_ALLOWED', message: 'not on the longshot allowlist' });
    }

    const parsed = SpinBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }

    const { stake_base_units: stakeStr, odds_choice } = parsed.data;

    if (!isValidOddsChoice(odds_choice)) {
      return reply.code(400).send({ error: 'INVALID_ODDS', message: 'odds_choice must be one of 1:1, 2:1, 3:1, 10:1' });
    }

    const stake = BigInt(stakeStr);
    const minStake = BigInt(app.config.longShotMinBaseUnits);
    const maxStake = BigInt(app.config.longShotMaxBaseUnits);
    if (stake < minStake || stake > maxStake) {
      return reply.code(400).send({ error: 'STAKE_OUT_OF_RANGE', message: `stake must be between ${minStake} and ${maxStake} base units` });
    }

    const p = winProbabilityFor(odds_choice);
    const m = payoutMultipleFor(odds_choice);
    const draw = randomness.drawSpin(p);
    const won = draw.outcome;
    const rvHex = draw.hex;
    const payout = stake * BigInt(m);

    const email = s.email;
    const betId = randomUUID();
    const now = new Date();
    const capBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;

    type SpinResult =
      | { ok: true; outcome: 'WIN' | 'LOSE'; net_user_change_base_units: bigint; new_balance_base_units: bigint; signature: Buffer }
      | { error: string; message: string; status: number };

    let result: SpinResult;
    try {
      result = await withTx<SpinResult>(app.pool, async (c) => {
        // Read current balance
        const { rows: balRows } = await c.query<{ total: string }>(
          `SELECT COALESCE(SUM(value), 0)::text AS total FROM tokens WHERE owner_email = $1 AND state = 'VALID'`,
          [email],
        );
        const balance = BigInt(balRows[0].total);

        if (balance < stake) {
          return { error: 'INSUFFICIENT_BALANCE', message: 'not enough tokens', status: 409 };
        }

        let netChange: bigint;
        let newBalance: bigint;
        let mintedDelta: bigint;

        if (won) {
          // WIN: mint payout tokens to user, increment minted_supply (cap-checked)
          const supplyResult = await c.query(
            `UPDATE app_counters SET value = value + $1::bigint
             WHERE name = 'minted_supply' AND value + $1::bigint <= $2::bigint`,
            [payout.toString(), capBaseUnits.toString()],
          );
          if ((supplyResult.rowCount ?? 0) === 0) {
            return { error: 'SUPPLY_CAP_REACHED', message: 'minted supply cap reached', status: 503 };
          }

          // Insert new token for winner
          const tokenId = randomUUID();
          const issuedAt = now;
          const ownerEmailHash = createHash('sha256').update(email).digest('hex');
          const sig = signTokenPayload(
            { id: tokenId, owner_email_hash: ownerEmailHash, value: payout, issued_at: issuedAt.toISOString() },
            app.config.signingPrivateKeyHex,
          );
          await c.query(
            `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
             VALUES($1, $2, $3, 'VALID', $4, $5)`,
            [tokenId, email, payout.toString(), issuedAt, sig],
          );

          // Decrement house PnL (house lost the payout)
          await c.query(
            `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'long_shot_house_pnl_base_units'`,
            [payout.toString()],
          );

          netChange = payout;
          newBalance = balance + payout;
          mintedDelta = payout;
        } else {
          // LOSE: burn stake from user's tokens, decrement minted_supply, increment house PnL
          await burnFromUser(c, email, stake, app.config.signingPrivateKeyHex);

          await c.query(
            `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply'`,
            [stake.toString()],
          );

          await c.query(
            `UPDATE app_counters SET value = value + $1::bigint WHERE name = 'long_shot_house_pnl_base_units'`,
            [stake.toString()],
          );

          netChange = -stake;
          newBalance = balance - stake;
          mintedDelta = -stake;
        }

        // Sign the bet receipt: sign over canonical bet fields
        const outcomeStr: 'WIN' | 'LOSE' = won ? 'WIN' : 'LOSE';
        const betPayload = {
          id: betId,
          owner_email_hash: createHash('sha256').update(email).digest('hex'),
          value: stake,
          issued_at: now.toISOString(),
        };
        const betSig = signTokenPayload(betPayload, app.config.signingPrivateKeyHex);

        // Insert audit row
        await c.query(
          `INSERT INTO long_shot_bets
           (id, account_email, stake_base_units, odds_choice, win_probability, payout_multiple,
            outcome, net_user_change_base_units, total_minted_delta_base_units, random_value_hex, signature, created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            betId,
            email,
            stake.toString(),
            odds_choice,
            p.toFixed(7),
            m,
            outcomeStr,
            netChange.toString(),
            mintedDelta.toString(),
            rvHex,
            betSig,
            now,
          ],
        );

        return { ok: true, outcome: outcomeStr, net_user_change_base_units: netChange, new_balance_base_units: newBalance, signature: betSig };
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

    return {
      id: betId,
      outcome: result.outcome,
      net_user_change_base_units: result.net_user_change_base_units.toString(),
      new_balance_base_units: result.new_balance_base_units.toString(),
      random_value_hex: rvHex,
      signature: result.signature.toString('hex'),
      server_time: now.toISOString(),
    };
  });

  app.get('/api/longshot/history', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const limitRaw = (req.query as { limit?: string })?.limit ?? '20';
    const limit = Math.max(1, Math.min(100, parseInt(limitRaw, 10) || 20));

    const { rows } = await app.pool.query<{
      id: string;
      stake_base_units: string;
      odds_choice: string;
      outcome: string;
      net_user_change_base_units: string;
      created_at: Date;
    }>(
      `SELECT id, stake_base_units::text, odds_choice, outcome,
              net_user_change_base_units::text, created_at
       FROM long_shot_bets
       WHERE account_email = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [s.email, limit],
    );
    return { spins: rows.map(r => ({ ...r, created_at: r.created_at.toISOString() })) };
  });

  app.get('/api/longshot/stats', async () => {
    const totals = await app.pool.query<{ total_spins: string; total_volume: string }>(
      `SELECT count(*)::text AS total_spins,
              COALESCE(SUM(stake_base_units), 0)::text AS total_volume
       FROM long_shot_bets`,
    );
    const pnl = await app.pool.query<{ value: string }>(
      `SELECT value::text FROM app_counters WHERE name = 'long_shot_house_pnl_base_units'`,
    );
    return {
      total_spins: parseInt(totals.rows[0].total_spins, 10),
      total_volume_base_units: totals.rows[0].total_volume,
      house_pnl_base_units: pnl.rows[0]?.value ?? '0',
    };
  });
}
