-- AMM slice 1: add USDC balance + terms-acceptance flag to users.
--
-- USDC is held at 6 decimals (Solana native — 1 USDC = 1,000,000 base units).
-- The pool, swap, and LP tables come in subsequent slices; this migration only
-- adds the two columns needed to track per-user balance + risk-acceptance state.

ALTER TABLE users
  ADD COLUMN usdc_base_units BIGINT NOT NULL DEFAULT 0
    CHECK (usdc_base_units >= 0),
  ADD COLUMN amm_terms_accepted_at TIMESTAMPTZ NULL;
