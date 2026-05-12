-- AMM slice 5: USDC deposit indexer schema (Phantom-link model).

ALTER TABLE users
  ADD COLUMN solana_pubkey TEXT UNIQUE NULL;

CREATE TABLE usdc_deposits (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_email      TEXT NOT NULL REFERENCES users(email),
  amount_base_units  BIGINT NOT NULL CHECK (amount_base_units > 0),
  solana_signature   TEXT NOT NULL UNIQUE,
  sender_pubkey      TEXT NOT NULL,
  block_time         TIMESTAMPTZ,
  credited_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX usdc_deposits_account_idx
  ON usdc_deposits(account_email, credited_at DESC);

CREATE TABLE usdc_unattributed_deposits (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_base_units  BIGINT NOT NULL CHECK (amount_base_units > 0),
  solana_signature   TEXT NOT NULL UNIQUE,
  sender_pubkey      TEXT NOT NULL,
  block_time         TIMESTAMPTZ,
  observed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by_email   TEXT NULL REFERENCES users(email),
  claimed_at         TIMESTAMPTZ NULL
);
CREATE INDEX usdc_unattributed_unclaimed_idx
  ON usdc_unattributed_deposits(observed_at DESC)
  WHERE claimed_by_email IS NULL;

CREATE TABLE amm_indexer_state (
  key                TEXT PRIMARY KEY,
  last_signature     TEXT,
  last_run_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO amm_indexer_state(key) VALUES ('usdc_deposits') ON CONFLICT DO NOTHING;
