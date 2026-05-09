import type { FastifyInstance } from 'fastify';
import { readSession } from './auth.js';
import { currentRewardBaseUnits } from '../schedule.js';
import { isAllowed } from '../wrap-allowlist.js';

const SOLUTIONS_PER_DAY_PER_HUMAN = 100_000n;

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const email = s.email;
    const todayUtc = new Date().toISOString().slice(0, 10);
    const [
      { rows: bal },
      { rows: minted },
      { rows: sent },
      { rows: recv },
      { rows: userRow },
      { rows: wrappedRow },
      { rows: bucketRow },
      { rows: counterRow },
    ] = await Promise.all([
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(value),0)::text AS n FROM tokens WHERE owner_email=$1 AND state='VALID'`,
        [email],
      ),
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(value),0)::text AS n FROM tokens WHERE owner_email=$1 AND parent_token_id IS NULL`,
        [email],
      ),
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(amount),0)::text AS n FROM transfers WHERE sender_email=$1`,
        [email],
      ),
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(amount),0)::text AS n FROM transfers WHERE recipient_email=$1`,
        [email],
      ),
      app.pool.query<{ solana_wallet: string | null }>(
        'SELECT solana_wallet FROM users WHERE email=$1', [email],
      ),
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(value),0)::text AS n FROM tokens WHERE owner_email=$1 AND state='WRAPPED'`,
        [email],
      ),
      app.pool.query<{ total_base_units: string }>(
        `SELECT total_base_units::text AS total_base_units FROM daily_mint_buckets WHERE email=$1 AND day_utc=$2`,
        [email, todayUtc],
      ),
      app.pool.query<{ value: string }>(
        `SELECT value::text AS value FROM app_counters WHERE name='minted_supply'`,
      ),
    ]);

    const mintedSupply = counterRow[0] ? BigInt(counterRow[0].value) : 0n;
    const reward = currentRewardBaseUnits(mintedSupply, { maxSupplyRpow: app.config.mintMaxSupply });
    const dailyCap = reward * SOLUTIONS_PER_DAY_PER_HUMAN;
    const dailyMintedToday = bucketRow[0] ? BigInt(bucketRow[0].total_base_units) : 0n;

    return {
      email,
      balance_base_units: bal[0]!.n,
      minted_base_units: minted[0]!.n,
      sent_base_units: sent[0]!.n,
      received_base_units: recv[0]!.n,
      wrap_allowed: isAllowed(app.wrapAllowlist, email),
      solana_wallet: userRow[0]?.solana_wallet ?? null,
      srpow_supply_owned_base_units: wrappedRow[0]?.n ?? '0',
      daily_mint_cap_base_units: dailyCap.toString(),
      daily_minted_base_units: dailyMintedToday.toString(),
      daily_remaining_base_units: (dailyCap > dailyMintedToday ? dailyCap - dailyMintedToday : 0n).toString(),
    };
  });
}
