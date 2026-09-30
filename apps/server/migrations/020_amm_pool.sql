-- AMM slice 2: pool reserves + LP balances + swap/LP audit tables.
--
-- Singleton constant-product pool. id forced to 'main' via CHECK so
-- there's exactly one row. Reserves are strictly positive (CHECK > 0) —
-- the seed endpoint enforces this; subsequent swaps must never drive
-- either reserve to zero (the floor is enforced by MIN_LIQUIDITY in
-- total_lp_supply at seed time).

CREATE TABLE amm_pool (
  id                       TEXT PRIMARY KEY DEFAULT 'main',
  rpow_reserve_base_units  BIGINT NOT NULL CHECK (rpow_reserve_base_units > 0),
  usdc_reserve_base_units  BIGINT NOT NULL CHECK (usdc_reserve_base_units > 0),
  total_lp_supply          BIGINT NOT NULL CHECK (total_lp_supply > 0),
  fee_bps                  INT NOT NULL DEFAULT 30 CHECK (fee_bps BETWEEN 0 AND 1000),
  seeded_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 'main')
);

-- Per-user LP token balance. The seed mints `isqrt(rpow*usdc) - MIN_LIQUIDITY`
-- to the admin; MIN_LIQUIDITY units stay in total_lp_supply but credited to no
-- one (permanent burn), guaranteeing the pool can't be 100% drained.
CREATE TABLE amm_lp_balances (
  account_email TEXT PRIMARY KEY REFERENCES users(email),
  lp_balance    BIGINT NOT NULL CHECK (lp_balance >= 0)
);

-- Ed25519-signed audit row per swap. Each row is independently verifiable
-- against the pool's signing public key.
CREATE TABLE amm_swaps (
  id                    UUID PRIMARY KEY,
  account_email         TEXT NOT NULL REFERENCES users(email),
  direction             TEXT NOT NULL CHECK (direction IN ('BUY','SELL')),
  rpow_delta_base_units BIGINT NOT NULL,
  usdc_delta_base_units BIGINT NOT NULL,
  fee_base_units        BIGINT NOT NULL,
  pool_rpow_after       BIGINT NOT NULL,
  pool_usdc_after       BIGINT NOT NULL,
  signature             BYTEA NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX amm_swaps_account_idx ON amm_swaps(account_email, created_at DESC);
CREATE INDEX amm_swaps_recent_idx  ON amm_swaps(created_at DESC);

-- LP add/remove audit. Used by slice 3 endpoints; ships here so the AMM
-- schema is one migration.
CREATE TABLE amm_lp_events (
  id                     UUID PRIMARY KEY,
  account_email          TEXT NOT NULL REFERENCES users(email),
  type                   TEXT NOT NULL CHECK (type IN ('ADD','REMOVE')),
  rpow_delta_base_units  BIGINT NOT NULL,
  usdc_delta_base_units  BIGINT NOT NULL,
  lp_delta_base_units    BIGINT NOT NULL,
  pool_rpow_after        BIGINT NOT NULL,
  pool_usdc_after        BIGINT NOT NULL,
  total_lp_after         BIGINT NOT NULL,
  signature              BYTEA NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX amm_lp_events_account_idx ON amm_lp_events(account_email, created_at DESC);
