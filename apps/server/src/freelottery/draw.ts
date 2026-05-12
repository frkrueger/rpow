import type { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import type { AppConfig } from '../buildApp.js';
import { withTx } from '../db.js';
import { signTokenPayload } from '../signing.js';
import { pickSupplyShard } from '../supplyShards.js';
import { BASE_UNITS_PER_RPOW } from './codes.js';
import { fetchDrawEntropy } from './solanaBlock.js';
import { pickWinner, type Entry } from './selection.js';
import { type ScheduleConfig } from './schedule.js';

export interface RunOneDayOpts {
  pool: Pool;
  config: AppConfig;
  dayUtc: string;
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
}

export type RunOneDayResult =
  | { status: 'empty'; winner_email: null; total_tickets: 0 }
  | { status: 'ok'; winner_email: string; total_tickets: number; slot: number; blockhash: string }
  | { status: 'already_processed' };

/**
 * Process the draw for a single `day_utc`. Idempotent — if a `freelottery_draws`
 * row already exists for `dayUtc`, returns `{ status: 'already_processed' }` and
 * performs no writes. Otherwise loads entries, picks a winner if any, and inserts
 * the draw row plus the prize token in a single transaction.
 */
export async function runOneDay(opts: RunOneDayOpts): Promise<RunOneDayResult> {
  if (!opts.config.solanaRpcUrl) {
    throw new Error('solanaRpcUrl is not configured');
  }

  // Pre-flight: short-circuit if we've already processed this day.
  const existing = await opts.pool.query(
    `SELECT 1 FROM freelottery_draws WHERE day_utc = $1`,
    [opts.dayUtc],
  );
  if (existing.rows.length > 0) return { status: 'already_processed' };

  // Load entries.
  const entriesRes = await opts.pool.query<Entry>(
    `SELECT account_email, ticket_count, verified_at::text AS verified_at
     FROM freelottery_entries
     WHERE day_utc = $1
     ORDER BY verified_at ASC, account_email ASC`,
    [opts.dayUtc],
  );
  const entries = entriesRes.rows;

  // Empty day → insert status='empty' row, no mint.
  if (entries.length === 0) {
    await opts.pool.query(
      `INSERT INTO freelottery_draws
         (day_utc, drawn_at, total_tickets, prize_base_units, status)
       VALUES ($1, now(), 0, $2, 'empty')
       ON CONFLICT (day_utc) DO NOTHING`,
      [opts.dayUtc, opts.config.freelotteryPrizeBaseUnits.toString()],
    );
    return { status: 'empty', winner_email: null, total_tickets: 0 };
  }

  // Non-empty day → fetch entropy, pick winner.
  const entropy = await fetchDrawEntropy({
    rpcUrl: opts.config.solanaRpcUrl,
    fetchImpl: opts.fetchImpl,
  });
  const winner = pickWinner(entries, entropy.blockhash);
  if (!winner) throw new Error('pickWinner returned null with non-empty entries');

  const totalTickets = entries.reduce((sum, e) => sum + e.ticket_count, 0);
  const prizeBaseUnits = opts.config.freelotteryPrizeBaseUnits;
  const capBaseUnits = BigInt(opts.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;
  const tokenId = randomUUID();
  const issuedAt = new Date();
  const ownerHash = createHash('sha256').update(winner.account_email).digest('hex');
  const sig = signTokenPayload(
    {
      id: tokenId,
      owner_email_hash: ownerHash,
      value: prizeBaseUnits,
      issued_at: issuedAt.toISOString(),
    },
    opts.config.signingPrivateKeyHex,
  );
  const supplyShard = pickSupplyShard();

  // Read winner's x_handle for the draws row.
  const userRes = await opts.pool.query<{ x_handle: string | null }>(
    `SELECT x_handle FROM users WHERE email = $1`,
    [winner.account_email],
  );
  const winnerXHandle = userRes.rows[0]?.x_handle ?? null;

  // Single transaction: increment supply (sharded, cap-guarded) + insert token + insert draw row.
  await withTx(opts.pool, async (c) => {
    const mintRes = await c.query(
      `WITH inc AS (
         UPDATE app_counters SET value = value + $2::bigint
         WHERE name='minted_supply' AND shard = $8
           AND (SELECT COALESCE(SUM(value), 0) FROM app_counters WHERE name='minted_supply')
               + $2::bigint <= $1::bigint
         RETURNING 1
       )
       INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
       SELECT $3, $4, $5::bigint, 'VALID', $6, $7 FROM inc
       RETURNING id`,
      [
        capBaseUnits.toString(),
        prizeBaseUnits.toString(),
        tokenId,
        winner.account_email,
        prizeBaseUnits.toString(),
        issuedAt,
        sig,
        supplyShard,
      ],
    );
    if (mintRes.rowCount === 0) {
      throw new Error('SUPPLY_EXHAUSTED — minted_supply cap reached before freelottery draw');
    }
    await c.query(
      `INSERT INTO freelottery_draws
         (day_utc, drawn_at, solana_slot, solana_blockhash, total_tickets,
          winner_email, winner_x_handle, prize_base_units, mint_credited_at, status)
       VALUES ($1, now(), $2, $3, $4, $5, $6, $7, now(), 'ok')`,
      [
        opts.dayUtc,
        entropy.slot,
        entropy.blockhash,
        totalTickets,
        winner.account_email,
        winnerXHandle,
        prizeBaseUnits.toString(),
      ],
    );
  });

  return {
    status: 'ok',
    winner_email: winner.account_email,
    total_tickets: totalTickets,
    slot: entropy.slot,
    blockhash: entropy.blockhash,
  };
}

/**
 * Scheduler entry point. Finds any `day_utc` in the campaign window that's
 * already past its `drawHourUtc` boundary and runs them in chronological order.
 * `runOneDay` short-circuits already-processed days.
 */
export async function runDraw(opts: {
  pool: Pool;
  config: AppConfig;
  fetchImpl?: typeof fetch;
}): Promise<{ ran: number }> {
  const sched: ScheduleConfig = {
    startUtcDate: opts.config.freelotteryStartUtcDate,
    totalDays: opts.config.freelotteryTotalDays,
    drawHourUtc: opts.config.freelotteryDrawHourUtc,
  };
  if (!sched.startUtcDate) return { ran: 0 };

  const now = new Date();
  // Walk day 1..totalDays; collect every day_utc whose draw hour has already
  // passed (so we never run today's draw before its 19:00 UTC boundary). The
  // `runOneDay` short-circuit handles "already processed."
  const startDate = new Date(`${sched.startUtcDate}T00:00:00Z`);
  const candidates: string[] = [];
  for (let i = 0; i < sched.totalDays; i++) {
    const d = new Date(startDate);
    d.setUTCDate(d.getUTCDate() + i);
    const ymd = d.toISOString().slice(0, 10);
    const drawMoment = new Date(`${ymd}T${String(sched.drawHourUtc).padStart(2, '0')}:00:00Z`);
    if (drawMoment.getTime() > now.getTime()) break;
    candidates.push(ymd);
  }

  let ran = 0;
  for (const dayUtc of candidates) {
    const r = await runOneDay({ pool: opts.pool, config: opts.config, dayUtc, fetchImpl: opts.fetchImpl });
    if (r.status !== 'already_processed') ran++;
  }
  return { ran };
}
