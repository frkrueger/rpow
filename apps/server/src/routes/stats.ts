import type { FastifyInstance } from 'fastify';
import type {
  StatsBalanceHistogramBucket,
  StatsHistoryPoint,
  StatsHistoryResponse,
  StatsHistoryWindow,
  StatsSummaryResponse,
  StatsTopBalance,
} from '@rpow/shared';
import { z } from 'zod';
import { BASE_UNITS_PER_RPOW, scheduleInfo } from '../schedule.js';

const SUMMARY_CACHE_MS = 10_000;
const HISTORY_CACHE_MS = 30_000;

const HistoryQuery = z.object({
  window: z.enum(['24h', '7d', '30d', 'all']).default('24h'),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

const HISTORY_WINDOWS: Record<StatsHistoryWindow, { interval: string; bucketInterval: string; bucketSeconds: number; allTime?: boolean }> = {
  '24h': { interval: '24 hours', bucketInterval: '15 minutes', bucketSeconds: 15 * 60 },
  '7d': { interval: '7 days', bucketInterval: '1 hour', bucketSeconds: 60 * 60 },
  '30d': { interval: '30 days', bucketInterval: '6 hours', bucketSeconds: 6 * 60 * 60 },
  all: { interval: '100 years', bucketInterval: '1 day', bucketSeconds: 24 * 60 * 60, allTime: true },
};

type StatsSummary = StatsSummaryResponse;

export async function statsRoutes(app: FastifyInstance) {
  let summaryCache: { ts: number; body: StatsSummary } | null = null;
  let summaryInflight: Promise<StatsSummary> | null = null;
  const historyCache = new Map<string, { ts: number; body: StatsHistoryResponse }>();

  async function computeSummary(): Promise<StatsSummary> {
    const [
      counter,
      transferred,
      users,
      balances,
      histogram,
      topBalances,
      activity,
      activeChallengers,
      wrapActivity,
      boundWallets,
    ] = await Promise.all([
      app.pool.query<{ value: string }>(`SELECT value::text AS value FROM app_counters WHERE name='minted_supply'`),
      app.pool.query<{ n: string }>(`SELECT coalesce(sum(amount),0)::bigint::text AS n FROM transfers`),
      app.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`),
      app.pool.query<{
        holder_count: number;
        circulating_supply_base_units: string;
        average_balance_base_units: string;
      }>(
        `WITH aggregate AS (
           SELECT count(*) FILTER (WHERE valid_balance > 0)::int AS holder_count,
                  coalesce(sum(valid_balance) FILTER (WHERE valid_balance > 0), 0)::bigint AS circulating_supply_base_units
           FROM user_balances
         )
         SELECT holder_count,
                circulating_supply_base_units::text AS circulating_supply_base_units,
                CASE
                  WHEN holder_count > 0 THEN (circulating_supply_base_units / holder_count)::text
                  ELSE '0'
                END AS average_balance_base_units
         FROM aggregate`,
      ),
      app.pool.query<StatsBalanceHistogramBucket>(
        `WITH buckets(bucket, min_balance_base_units, max_balance_base_units, sort_key) AS (
           VALUES
             ('0-0.001', 1::bigint, 999999::bigint, 1),
             ('0.001-0.01', 1000000::bigint, 9999999::bigint, 2),
             ('0.01-0.1', 10000000::bigint, 99999999::bigint, 3),
             ('0.1-1', 100000000::bigint, 999999999::bigint, 4),
             ('1-10', 1000000000::bigint, 9999999999::bigint, 5),
             ('10-100', 10000000000::bigint, 99999999999::bigint, 6),
             ('100+', 100000000000::bigint, NULL::bigint, 7)
         )
         SELECT buckets.bucket,
                buckets.min_balance_base_units::text AS min_balance_base_units,
                buckets.max_balance_base_units::text AS max_balance_base_units,
                count(user_balances.owner_email)::int AS holder_count,
                coalesce(sum(user_balances.valid_balance), 0)::bigint::text AS total_balance_base_units
         FROM buckets
         JOIN user_balances
           ON user_balances.valid_balance >= buckets.min_balance_base_units
          AND (buckets.max_balance_base_units IS NULL OR user_balances.valid_balance <= buckets.max_balance_base_units)
         GROUP BY buckets.bucket, buckets.min_balance_base_units, buckets.max_balance_base_units, buckets.sort_key
         ORDER BY buckets.sort_key`,
      ),
      app.pool.query<StatsTopBalance>(
        `SELECT row_number() OVER (ORDER BY valid_balance DESC)::int AS rank,
                valid_balance::text AS balance_base_units
         FROM user_balances
         WHERE valid_balance > 0
         ORDER BY valid_balance DESC
         LIMIT 25`,
      ),
      app.pool.query<{
        mint_count_1h: number;
        mint_count_24h: number;
        minted_base_units_1h: string;
        minted_base_units_24h: string;
        transfer_count_1h: number;
        transfer_count_24h: number;
        transferred_base_units_1h: string;
        transferred_base_units_24h: string;
      }>(
        `SELECT
           (SELECT count(*)::int FROM tokens WHERE parent_token_id IS NULL AND NOT is_change AND issued_at > now() - interval '1 hour') AS mint_count_1h,
           (SELECT count(*)::int FROM tokens WHERE parent_token_id IS NULL AND NOT is_change AND issued_at > now() - interval '24 hours') AS mint_count_24h,
           (SELECT coalesce(sum(value),0)::bigint::text FROM tokens WHERE parent_token_id IS NULL AND NOT is_change AND issued_at > now() - interval '1 hour') AS minted_base_units_1h,
           (SELECT coalesce(sum(value),0)::bigint::text FROM tokens WHERE parent_token_id IS NULL AND NOT is_change AND issued_at > now() - interval '24 hours') AS minted_base_units_24h,
           (SELECT count(*)::int FROM transfers WHERE created_at > now() - interval '1 hour') AS transfer_count_1h,
           (SELECT count(*)::int FROM transfers WHERE created_at > now() - interval '24 hours') AS transfer_count_24h,
           (SELECT coalesce(sum(amount),0)::bigint::text FROM transfers WHERE created_at > now() - interval '1 hour') AS transferred_base_units_1h,
           (SELECT coalesce(sum(amount),0)::bigint::text FROM transfers WHERE created_at > now() - interval '24 hours') AS transferred_base_units_24h`,
      ),
      app.pool.query<{ n: number }>(
        `SELECT count(DISTINCT user_email)::int AS n
         FROM challenges
         WHERE issued_at > now() - interval '15 minutes'`,
      ),
      app.pool.query<{ wrap_count_24h: number; wrapped_base_units_24h: string }>(
        `SELECT count(*)::int AS wrap_count_24h,
                coalesce(sum(amount), 0)::bigint::text AS wrapped_base_units_24h
         FROM srpow_wrap_events
         WHERE direction='WRAP' AND status='CONFIRMED'
           AND updated_at > now() - interval '24 hours'`,
      ),
      app.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM users WHERE solana_wallet IS NOT NULL`,
      ),
    ]);

    const totalMintedBaseUnits = BigInt(counter.rows[0]?.value ?? '0');
    const totalTransferredBaseUnits = BigInt(transferred.rows[0]?.n ?? '0');
    const balanceRow = balances.rows[0] ?? {
      holder_count: 0,
      circulating_supply_base_units: '0',
      average_balance_base_units: '0',
    };
    const circulatingBaseUnits = BigInt(balanceRow.circulating_supply_base_units);
    const maxSupplyBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;
    const info = scheduleInfo(totalMintedBaseUnits, {
      difficultyBits: app.config.difficultyBits,
      maxSupplyRpow: app.config.mintMaxSupply,
    });
    const userCount = users.rows[0]?.n ?? 0;
    const activityRow = activity.rows[0]!;

    return {
      sampled_at: new Date().toISOString(),
      ledger: {
        total_minted_base_units: totalMintedBaseUnits.toString(),
        total_transferred_base_units: totalTransferredBaseUnits.toString(),
        circulating_supply_base_units: circulatingBaseUnits.toString(),
        minted_supply_counter_base_units: totalMintedBaseUnits.toString(),
        max_supply_base_units: maxSupplyBaseUnits.toString(),
        base_units_per_rpow: BASE_UNITS_PER_RPOW.toString(),
        current_difficulty_bits: Math.max(app.config.difficultyFloor, info.currentDifficultyBits),
        current_reward_base_units: info.currentRewardBaseUnits.toString(),
        next_reward_base_units: info.nextRewardBaseUnits.toString(),
        next_halving_at_base_units: info.nextHalvingAtBaseUnits.toString(),
        base_units_to_next_halving: info.baseUnitsToNextHalving.toString(),
        halving_index: info.halvingIndex,
        is_capped: info.isCapped,
        user_count: userCount,
      },
      activity: {
        mint_count_1h: activityRow.mint_count_1h,
        mint_count_24h: activityRow.mint_count_24h,
        minted_base_units_1h: activityRow.minted_base_units_1h,
        minted_base_units_24h: activityRow.minted_base_units_24h,
        transfer_count_1h: activityRow.transfer_count_1h,
        transfer_count_24h: activityRow.transfer_count_24h,
        transferred_base_units_1h: activityRow.transferred_base_units_1h,
        transferred_base_units_24h: activityRow.transferred_base_units_24h,
        active_challengers_15m: activeChallengers.rows[0]?.n ?? 0,
        wrap_count_24h: wrapActivity.rows[0]?.wrap_count_24h ?? 0,
        wrapped_base_units_24h: wrapActivity.rows[0]?.wrapped_base_units_24h ?? '0',
        bound_wallet_count: boundWallets.rows[0]?.n ?? 0,
      },
      holders: {
        holder_count: balanceRow.holder_count,
        zero_balance_user_count: Math.max(0, userCount - balanceRow.holder_count),
        average_balance_base_units: balanceRow.average_balance_base_units,
        balance_histogram: histogram.rows,
        top_balances: topBalances.rows.map(row => ({
          rank: Number(row.rank),
          balance_base_units: row.balance_base_units,
        })),
      },
    };
  }

  async function summary(): Promise<StatsSummary> {
    if (summaryCache && Date.now() - summaryCache.ts < SUMMARY_CACHE_MS) return summaryCache.body;
    if (summaryInflight) return summaryInflight;
    summaryInflight = (async () => {
      try {
        const body = await computeSummary();
        summaryCache = { ts: Date.now(), body };
        return body;
      } finally {
        summaryInflight = null;
      }
    })();
    return summaryInflight;
  }

  async function history(window: StatsHistoryWindow, limit: number): Promise<StatsHistoryResponse> {
    const spec = HISTORY_WINDOWS[window];
    const { rows } = await app.pool.query<{
      bucket_start: Date;
      mint_count: number;
      minted_base_units: string;
      total_minted_base_units: string;
      transfer_count: number;
      transferred_base_units: string;
      total_transferred_base_units: string;
      circulating_supply_base_units: string;
      new_users: number;
      user_count: number;
      challenges: number;
      active_challengers: number;
    }>(
      `WITH params AS (
         SELECT $1::interval AS window_interval,
                $2::interval AS bucket_interval,
                $4::boolean AS all_time,
                TIMESTAMPTZ '1970-01-01 00:00:00+00' AS origin,
                date_bin($2::interval, now(), TIMESTAMPTZ '1970-01-01 00:00:00+00') AS end_bucket
       ),
       first_event AS (
         SELECT LEAST(
           COALESCE((SELECT min(issued_at) FROM tokens), now()),
           COALESCE((SELECT min(created_at) FROM transfers), now()),
           COALESCE((SELECT min(created_at) FROM users), now()),
           COALESCE((SELECT min(issued_at) FROM challenges), now()),
           COALESCE((SELECT min(created_at) FROM srpow_wrap_events), now())
         ) AS at
       ),
       bounds AS (
         SELECT CASE
                  WHEN params.all_time THEN date_bin(params.bucket_interval, first_event.at, params.origin)
                  ELSE date_bin(params.bucket_interval, now() - params.window_interval, params.origin)
                END AS start_bucket,
                params.end_bucket + params.bucket_interval AS end_exclusive,
                params.bucket_interval,
                params.origin
         FROM params, first_event
       ),
       buckets AS (
         SELECT gs AS bucket_start
         FROM bounds,
              generate_series(bounds.start_bucket, bounds.end_exclusive - bounds.bucket_interval, bounds.bucket_interval) AS gs
       ),
       mint_events AS (
         SELECT date_bin(bounds.bucket_interval, tokens.issued_at, bounds.origin) AS bucket_start,
                count(*)::int AS mint_count,
                coalesce(sum(tokens.value), 0)::bigint AS minted_base_units
         FROM tokens, bounds
         WHERE tokens.parent_token_id IS NULL
           AND NOT tokens.is_change
           AND tokens.issued_at >= bounds.start_bucket
           AND tokens.issued_at < bounds.end_exclusive
         GROUP BY 1
       ),
       transfer_events AS (
         SELECT date_bin(bounds.bucket_interval, transfers.created_at, bounds.origin) AS bucket_start,
                count(*)::int AS transfer_count,
                coalesce(sum(transfers.amount), 0)::bigint AS transferred_base_units
         FROM transfers, bounds
         WHERE transfers.created_at >= bounds.start_bucket
           AND transfers.created_at < bounds.end_exclusive
         GROUP BY 1
       ),
       user_events AS (
         SELECT date_bin(bounds.bucket_interval, users.created_at, bounds.origin) AS bucket_start,
                count(*)::int AS new_users
         FROM users, bounds
         WHERE users.created_at >= bounds.start_bucket
           AND users.created_at < bounds.end_exclusive
         GROUP BY 1
       ),
       challenge_events AS (
         SELECT date_bin(bounds.bucket_interval, challenges.issued_at, bounds.origin) AS bucket_start,
                count(*)::int AS challenges,
                count(DISTINCT challenges.user_email)::int AS active_challengers
         FROM challenges, bounds
         WHERE challenges.issued_at >= bounds.start_bucket
           AND challenges.issued_at < bounds.end_exclusive
         GROUP BY 1
       ),
       supply_events AS (
         SELECT date_bin(bounds.bucket_interval, tokens.issued_at, bounds.origin) AS bucket_start,
                tokens.value::bigint AS delta
         FROM tokens, bounds
         WHERE NOT tokens.is_change
           AND tokens.issued_at >= bounds.start_bucket
           AND tokens.issued_at < bounds.end_exclusive
         UNION ALL
         SELECT date_bin(bounds.bucket_interval, tokens.invalidated_at, bounds.origin) AS bucket_start,
                (-tokens.value)::bigint AS delta
         FROM tokens, bounds
         WHERE tokens.invalidated_at IS NOT NULL
           AND tokens.invalidated_at >= bounds.start_bucket
           AND tokens.invalidated_at < bounds.end_exclusive
         UNION ALL
         SELECT date_bin(bounds.bucket_interval, srpow_wrap_events.created_at, bounds.origin) AS bucket_start,
                (-tokens.value)::bigint AS delta
         FROM tokens
         JOIN srpow_wrap_events ON srpow_wrap_events.id = tokens.wrap_event_id,
              bounds
         WHERE NOT tokens.is_change
           AND srpow_wrap_events.status IN ('PENDING', 'CONFIRMED')
           AND srpow_wrap_events.created_at >= bounds.start_bucket
           AND srpow_wrap_events.created_at < bounds.end_exclusive
         UNION ALL
         SELECT date_bin(bounds.bucket_interval, srpow_wrap_events.updated_at, bounds.origin) AS bucket_start,
                tokens.value::bigint AS delta
         FROM tokens
         JOIN srpow_wrap_events ON srpow_wrap_events.id = tokens.wrap_event_id,
              bounds
         WHERE tokens.is_change
           AND srpow_wrap_events.status = 'CONFIRMED'
           AND srpow_wrap_events.updated_at >= bounds.start_bucket
           AND srpow_wrap_events.updated_at < bounds.end_exclusive
       ),
       supply_deltas AS (
         SELECT bucket_start, coalesce(sum(delta), 0)::bigint AS delta
         FROM supply_events
         GROUP BY bucket_start
       ),
       baseline AS (
         SELECT
           (SELECT coalesce(sum(tokens.value), 0)::bigint
            FROM tokens, bounds
            WHERE tokens.parent_token_id IS NULL
              AND NOT tokens.is_change
              AND tokens.issued_at < bounds.start_bucket) AS total_minted_base_units,
           (SELECT coalesce(sum(transfers.amount), 0)::bigint
            FROM transfers, bounds
            WHERE transfers.created_at < bounds.start_bucket) AS total_transferred_base_units,
           (SELECT count(*)::int
            FROM users, bounds
            WHERE users.created_at < bounds.start_bucket) AS user_count,
           (SELECT coalesce(sum(tokens.value), 0)::bigint
            FROM tokens
            LEFT JOIN srpow_wrap_events ON srpow_wrap_events.id = tokens.wrap_event_id,
                 bounds
            WHERE tokens.issued_at < bounds.start_bucket
              AND (
                (tokens.state = 'VALID' AND (
                  NOT tokens.is_change
                  OR tokens.wrap_event_id IS NULL
                  OR (srpow_wrap_events.status = 'CONFIRMED' AND srpow_wrap_events.updated_at < bounds.start_bucket)
                ))
                OR (tokens.state = 'INVALIDATED' AND tokens.invalidated_at >= bounds.start_bucket)
                OR (tokens.state IN ('LOCKED_FOR_BRIDGE', 'WRAPPED') AND NOT tokens.is_change AND srpow_wrap_events.created_at >= bounds.start_bucket)
              )) AS circulating_supply_base_units
       ),
       history_rows AS (
         SELECT buckets.bucket_start,
                coalesce(mint_events.mint_count, 0)::int AS mint_count,
                coalesce(mint_events.minted_base_units, 0)::bigint AS minted_base_units,
                (baseline.total_minted_base_units + sum(coalesce(mint_events.minted_base_units, 0)) OVER (ORDER BY buckets.bucket_start))::bigint AS total_minted_base_units,
                coalesce(transfer_events.transfer_count, 0)::int AS transfer_count,
                coalesce(transfer_events.transferred_base_units, 0)::bigint AS transferred_base_units,
                (baseline.total_transferred_base_units + sum(coalesce(transfer_events.transferred_base_units, 0)) OVER (ORDER BY buckets.bucket_start))::bigint AS total_transferred_base_units,
                (baseline.circulating_supply_base_units + sum(coalesce(supply_deltas.delta, 0)) OVER (ORDER BY buckets.bucket_start))::bigint AS circulating_supply_base_units,
                coalesce(user_events.new_users, 0)::int AS new_users,
                (baseline.user_count + sum(coalesce(user_events.new_users, 0)) OVER (ORDER BY buckets.bucket_start))::int AS user_count,
                coalesce(challenge_events.challenges, 0)::int AS challenges,
                coalesce(challenge_events.active_challengers, 0)::int AS active_challengers
         FROM buckets
         CROSS JOIN baseline
         LEFT JOIN mint_events USING (bucket_start)
         LEFT JOIN transfer_events USING (bucket_start)
         LEFT JOIN user_events USING (bucket_start)
         LEFT JOIN challenge_events USING (bucket_start)
         LEFT JOIN supply_deltas USING (bucket_start)
       )
       SELECT bucket_start,
              mint_count,
              minted_base_units::text AS minted_base_units,
              total_minted_base_units::text AS total_minted_base_units,
              transfer_count,
              transferred_base_units::text AS transferred_base_units,
              total_transferred_base_units::text AS total_transferred_base_units,
              circulating_supply_base_units::text AS circulating_supply_base_units,
              new_users,
              user_count,
              challenges,
              active_challengers
       FROM history_rows
       ORDER BY bucket_start DESC
       LIMIT $3`,
      [spec.interval, spec.bucketInterval, limit, !!spec.allTime],
    );

    const historyRows: StatsHistoryPoint[] = rows.reverse().map(row => {
      const totalMintedBaseUnits = BigInt(row.total_minted_base_units);
      const info = scheduleInfo(totalMintedBaseUnits, {
        difficultyBits: app.config.difficultyBits,
        maxSupplyRpow: app.config.mintMaxSupply,
      });
      return {
        bucket_start: row.bucket_start.toISOString(),
        total_minted_base_units: row.total_minted_base_units,
        mint_count: Number(row.mint_count),
        minted_base_units: row.minted_base_units,
        total_transferred_base_units: row.total_transferred_base_units,
        transfer_count: Number(row.transfer_count),
        transferred_base_units: row.transferred_base_units,
        circulating_supply_base_units: row.circulating_supply_base_units,
        new_users: Number(row.new_users),
        user_count: Number(row.user_count),
        current_difficulty_bits: Math.max(app.config.difficultyFloor, info.currentDifficultyBits),
        current_reward_base_units: info.currentRewardBaseUnits.toString(),
        challenges: Number(row.challenges),
        active_challengers: Number(row.active_challengers),
      };
    });

    return {
      window,
      bucket_seconds: spec.bucketSeconds,
      rows: historyRows,
    };
  }

  app.get('/stats/summary', async () => summary());

  app.get('/stats/history', async (req, reply) => {
    const parsed = HistoryQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid query' });
    const key = `${parsed.data.window}:${parsed.data.limit}`;
    const cached = historyCache.get(key);
    if (cached && Date.now() - cached.ts < HISTORY_CACHE_MS) return cached.body;

    const body = await history(parsed.data.window, parsed.data.limit);
    historyCache.set(key, { ts: Date.now(), body });
    return body;
  });
}
