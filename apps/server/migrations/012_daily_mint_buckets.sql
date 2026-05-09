-- 012_daily_mint_buckets.sql
-- Per-account per-day mint quota. Caps how much any single account can
-- mint in a UTC day to ~100,000 solutions worth of reward. Combined with
-- the halving schedule, this is a fixed-throughput-per-human design:
--   epoch 0 (reward 0.001 RPOW): cap =  100 RPOW/day/account
--   epoch 1 (reward 0.0005):     cap =   50 RPOW/day/account
--   epoch K:                     cap = (reward * 100,000) base units
--
-- A casual laptop miner running a worker at ~1.2 sol/sec stays under the
-- cap; a GPU rig hashing 100x faster fills the cap in ~15 minutes and
-- then sits idle until the next UTC midnight. Sybil farming is deterred
-- by the Turnstile gate on /auth/request (see migration 0NN... and
-- routes/auth.ts).

CREATE TABLE daily_mint_buckets (
  email             TEXT      NOT NULL,
  day_utc           DATE      NOT NULL,
  total_base_units  BIGINT    NOT NULL DEFAULT 0 CHECK (total_base_units >= 0),
  PRIMARY KEY (email, day_utc)
);

-- Buckets older than ~30 days have no operational value; a janitor
-- can DELETE them periodically. Index supports that cleanup query.
CREATE INDEX daily_mint_buckets_day_idx ON daily_mint_buckets(day_utc);
