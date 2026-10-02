# Public statistics

`GET /stats/summary` reports current ledger counters, recent events, and anonymous holder aggregates. Amounts are integer base-unit strings (1 RPOW = 1,000,000,000 units). Current supply and transferred totals sum all `app_counters` shards; current rewards use the same configuration as `/ledger`. Holder counts, histogram and top balances read `users.cached_balance`, maintained by the existing migration 036 trigger. No stats code changes token issuance, spending, claim, wrap or supply-cap decisions.

`GET /stats/history?window=24h|7d|30d|all&limit=1..1000` reports recent buckets in ascending time order. Windows use 15-minute, hourly, six-hour and daily buckets respectively; `limit` retains only the most recent buckets. Each bucket includes root-token issuance count/amount, transfer count/amount, new users, challenge count and distinct challengers. Empty buckets contain zeros.

Root tokens exclude change and have no parent token. They include mining, claims, game payouts, AMM buys and unwraps. Root issuance is **not** mined rewards or net supply growth. Existing rows cannot reconstruct historical minted/circulating balances or historical reward schedules, so the history API does not publish those fields. Holder distributions are current-only. No emails, account IDs, wallet addresses, token IDs or signatures appear in either response.

Summary refreshes are coalesced and cached for 10 seconds. History is cached for 30 seconds with at most 32 query variants. No client telemetry is accepted. `PUBLIC_STATS_ORIGINS` is an optional comma-separated list of additional origins: only GET/HEAD `/ledger`, `/stats/summary` and `/stats/history` receive non-credentialed CORS. Existing app origins retain their current credentialed access.

## Existing databases

Before enabling holder reporting on a database that predates migration 036, verify its cached balances have been backfilled. This PR does not automatically scan or rewrite an existing production ledger. The upstream backfill script alone does not serialize its snapshot with concurrent token writes. If backfill is needed, use a maintenance window or run the existing script inside a transaction holding `LOCK TABLE tokens IN SHARE MODE`, so token mutations wait until the backfill commits. Validate cached sums against valid tokens before enabling the report. This was tested only in a disposable local PostgreSQL database, including a concurrent insert waiting on that lock.

Migration 037 adds timestamp query indexes, not a second balance table. On a large live database, arrange concurrent index creation before applying the migration, as with upstream migrations 021/024; regular index creation can hold write-blocking locks. No production migration, backfill or deployment was performed for this PR.
