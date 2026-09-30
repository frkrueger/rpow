-- 013_long_shot.sql
-- RPOW Long Shot: a 4-tier random-outcome side feature.
-- House liquidity is the chain's unmined supply (no separate house account).
-- See docs/superpowers/specs/2026-05-09-rpow-long-shot-design.md.

CREATE TABLE long_shot_bets (
  id UUID PRIMARY KEY,
  account_email TEXT NOT NULL REFERENCES users(email),
  stake_base_units BIGINT NOT NULL CHECK (stake_base_units > 0),
  odds_choice TEXT NOT NULL CHECK (odds_choice IN ('1:1', '2:1', '3:1', '10:1')),
  win_probability NUMERIC(8,7) NOT NULL,
  payout_multiple SMALLINT NOT NULL CHECK (payout_multiple IN (1, 2, 3, 10)),
  outcome TEXT NOT NULL CHECK (outcome IN ('WIN', 'LOSE')),
  net_user_change_base_units BIGINT NOT NULL,
  total_minted_delta_base_units BIGINT NOT NULL,
  random_value_hex TEXT NOT NULL,
  signature BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX long_shot_bets_account_idx ON long_shot_bets(account_email, created_at DESC);
CREATE INDEX long_shot_bets_created_at_idx ON long_shot_bets(created_at DESC);

INSERT INTO app_counters (name, value)
  VALUES ('long_shot_house_pnl_base_units', 0)
  ON CONFLICT (name) DO NOTHING;
