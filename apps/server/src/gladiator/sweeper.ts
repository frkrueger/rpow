import { randomUUID, createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTx } from '../db.js';
import { signTokenPayload } from '../signing.js';
import { pickSupplyShard } from '../supplyShards.js';

const BASE_UNITS_PER_RPOW = 1_000_000_000n;

export async function sweepInactiveSessions(
  pool: Pool,
  opts: {
    signingPrivateKeyHex: string;
    ttlHours: number;
    mintMaxSupply: number; // RPOW units (not base units)
  },
): Promise<{ swept: number }> {
  // Find all OPEN sessions that have been inactive beyond the TTL
  const candidatesRes = await pool.query<{ id: string }>(
    `SELECT id
     FROM gladiator_sessions
     WHERE status = 'OPEN'
       AND COALESCE(last_flip_at, opened_at) < now() - $1::interval`,
    [`${opts.ttlHours} hours`],
  );

  let swept = 0;

  for (const candidate of candidatesRes.rows) {
    try {
      await withTx(pool, async (c) => {
        // Lock and re-check
        const sessRes = await c.query<{
          id: string;
          account_email: string;
          bankroll_remaining_base_units: string;
          status: string;
        }>(
          `SELECT id, account_email, bankroll_remaining_base_units::text, status
           FROM gladiator_sessions
           WHERE id = $1
           FOR UPDATE`,
          [candidate.id],
        );

        if (sessRes.rows.length === 0 || sessRes.rows[0].status !== 'OPEN') {
          // Already closed between scan and lock — skip
          return;
        }

        const sess = sessRes.rows[0];
        const email = sess.account_email;
        const remaining = BigInt(sess.bankroll_remaining_base_units);

        // Look up x_handle for chat message
        const userRes = await c.query<{ x_handle: string | null }>(
          `SELECT x_handle FROM users WHERE email = $1`,
          [email],
        );
        const xHandle = userRes.rows[0]?.x_handle ?? email;

        // Mint back remaining bankroll if > 0
        if (remaining > 0n) {
          const capBaseUnits = BigInt(opts.mintMaxSupply) * BASE_UNITS_PER_RPOW;
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

          const tokenId = randomUUID();
          const issuedAt = new Date();
          const ownerEmailHash = createHash('sha256').update(email).digest('hex');
          const sig = signTokenPayload(
            { id: tokenId, owner_email_hash: ownerEmailHash, value: remaining, issued_at: issuedAt.toISOString() },
            opts.signingPrivateKeyHex,
          );
          await c.query(
            `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
             VALUES($1, $2, $3, 'VALID', $4, $5)`,
            [tokenId, email, remaining.toString(), issuedAt, sig],
          );
        }

        // Close the session
        await c.query(
          `UPDATE gladiator_sessions
           SET status = 'CLOSED', closed_at = now()
           WHERE id = $1`,
          [candidate.id],
        );

        // Insert SYSTEM chat message
        await c.query(
          `INSERT INTO gladiator_chat_messages (id, account_email, x_handle, kind, body)
           VALUES ($1, NULL, NULL, 'SYSTEM', $2)`,
          [randomUUID(), `@${xHandle} was auto-closed for inactivity`],
        );

        swept++;
      });
    } catch (e: any) {
      // Bubble SUPPLY_CAP_REACHED so the calling cron can log it
      if (e?.message === 'SUPPLY_CAP_REACHED') {
        throw e;
      }
      // Other unexpected errors: rethrow as well
      throw e;
    }
  }

  return { swept };
}
