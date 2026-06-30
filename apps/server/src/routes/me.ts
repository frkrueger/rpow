import type { FastifyInstance } from 'fastify';
import { readAuth } from './auth.js';
import { currentRewardBaseUnits } from '../schedule.js';
import { isAllowed } from '../wrap-allowlist.js';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from '../session.js';

const SOLUTIONS_PER_DAY_PER_HUMAN = 100_000n;
const ME_CACHE_MS = 30_000;

export async function meRoutes(app: FastifyInstance) {
  const meCache = new Map<string, { ts: number; body: object }>();
  const meInflight = new Map<string, Promise<object>>();

  app.get('/me', async (req, reply) => {
    const s = await readAuth(req, app);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    // Auto-heal stale cookie state from the pre-deploy era. Users who signed
    // in before the .rpow2.com domain switch may still have a legacy host-only
    // HttpOnly rpow_session cookie that JS in AuthCallback can't clear (HttpOnly
    // blocks JS write/clear). Reissue server-side on every /me: clear the
    // legacy host-only entry and set the domain-scoped one. Makes "click link,
    // works" actually work for everyone on next page load — no manual cookie
    // clearing required.
    // SKIP cookie reissue on API-key auth — there's no cookie to heal.
    if (app.config.secureCookies && !s.viaApiKey) {
      const freshToken = signSession({ email: s.email }, app.config.sessionSecret, SESSION_TTL_SECONDS);
      reply.header('Set-Cookie', [
        // Clear legacy host-only cookie (no Domain attribute → host-only match).
        `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`,
        // Reissue with proper Domain so it works across subdomains. Match
        // AuthCallback's non-HttpOnly format for consistency with the new flow.
        `${SESSION_COOKIE}=${freshToken}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; Domain=.rpow2.com; SameSite=Lax; Secure`,
      ]);
    }

    const email = s.email;

    reply.header('Cache-Control', 'private, max-age=10, stale-while-revalidate=20');

    const hit = meCache.get(email);
    if (hit && Date.now() - hit.ts < ME_CACHE_MS) return hit.body;

    let inflight = meInflight.get(email);
    if (!inflight) {
      inflight = (async () => {
        try {
          const todayUtc = new Date().toISOString().slice(0, 10);
          const [
            { rows: tokensRow },
            { rows: transfersRow },
            { rows: userRow },
            { rows: bucketRow },
            { rows: counterRow },
          ] = await Promise.all([
            // Read pre-maintained per-user balance cache from users table (O(1) index lookup).
            // Maintained by the tokens_maintain_user_balance_cache trigger (migration 036).
            app.pool.query<{ balance: string; wrapped: string; minted: string }>(
              `SELECT
                cached_balance::text AS balance,
                cached_wrapped::text AS wrapped,
                cached_minted::text  AS minted
              FROM users
              WHERE email = $1`,
              [email],
            ),
            // Single scan over the user's transfers with FILTER aggregates (replaces 2 separate queries).
            app.pool.query<{ sent: string; received: string }>(
              `SELECT
                COALESCE(SUM(amount) FILTER (WHERE sender_email = $1),    0)::text AS sent,
                COALESCE(SUM(amount) FILTER (WHERE recipient_email = $1), 0)::text AS received
              FROM transfers
              WHERE sender_email = $1 OR recipient_email = $1`,
              [email],
            ),
            app.pool.query<{
              solana_wallet: string | null;
              x_handle: string | null;
              x_avatar_url: string | null;
              usdc_base_units: string;
              amm_terms_accepted_at: Date | null;
            }>(
              'SELECT solana_wallet, x_handle, x_avatar_url, usdc_base_units::text AS usdc_base_units, amm_terms_accepted_at FROM users WHERE email=$1', [email],
            ),
            app.pool.query<{ total_base_units: string }>(
              `SELECT total_base_units::text AS total_base_units FROM daily_mint_buckets WHERE email=$1 AND day_utc=$2`,
              [email, todayUtc],
            ),
            app.pool.query<{ value: string }>(
              `SELECT COALESCE(SUM(value), 0)::text AS value FROM app_counters WHERE name='minted_supply'`,
            ),
          ]);

          const mintedSupply = counterRow[0] ? BigInt(counterRow[0].value) : 0n;
          const reward = currentRewardBaseUnits(mintedSupply, {
            baseRewardBaseUnits: app.config.baseRewardBaseUnits,
            maxSupplyRpow: app.config.mintMaxSupply,
          });
          const dailyCap = reward * SOLUTIONS_PER_DAY_PER_HUMAN;
          const dailyMintedToday = bucketRow[0] ? BigInt(bucketRow[0].total_base_units) : 0n;

          const body = {
            email,
            balance_base_units: tokensRow[0]!.balance,
            minted_base_units: tokensRow[0]!.minted,
            sent_base_units: transfersRow[0]!.sent,
            received_base_units: transfersRow[0]!.received,
            wrap_allowed: isAllowed(app.wrapAllowlist, email),
            solana_wallet: userRow[0]?.solana_wallet ?? null,
            x_handle: userRow[0]?.x_handle ?? null,
            x_avatar_url: userRow[0]?.x_avatar_url ?? null,
            srpow_supply_owned_base_units: tokensRow[0]?.wrapped ?? '0',
            daily_mint_cap_base_units: dailyCap.toString(),
            daily_minted_base_units: dailyMintedToday.toString(),
            daily_remaining_base_units: (dailyCap > dailyMintedToday ? dailyCap - dailyMintedToday : 0n).toString(),
            usdc_base_units: userRow[0]?.usdc_base_units ?? '0',
            amm_terms_accepted_at: userRow[0]?.amm_terms_accepted_at?.toISOString() ?? null,
          };
          meCache.set(email, { ts: Date.now(), body });
          return body;
        } finally {
          meInflight.delete(email);
        }
      })();
      meInflight.set(email, inflight);
    }
    return inflight;
  });
}
