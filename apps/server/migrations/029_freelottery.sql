-- 029_freelottery.sql
-- RPOW Daily Free Lottery: 100-day campaign, 1,000 RPOW/day from unmined
-- supply, X-tweet verification per day. See
-- docs/superpowers/specs/2026-05-12-daily-free-lottery-design.md.

-- 1. Per-(user, day) verification codes. Mirrors gladiator's
-- x_verification_codes but day-scoped. Deleted after successful verify;
-- otherwise expires at the day's 19:00 UTC boundary.
CREATE TABLE freelottery_codes (
  account_email TEXT NOT NULL REFERENCES users(email),
  day_utc       DATE NOT NULL,
  code          TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_email, day_utc)
);

-- 2. Verified daily entries. One row per (user, day_utc). ticket_count is
-- 1 (base) or 2 (holder of >= 1 RPOW at verify time). balance snapshot is
-- recorded so the tier decision is auditable later.
CREATE TABLE freelottery_entries (
  account_email                TEXT NOT NULL REFERENCES users(email),
  day_utc                      DATE NOT NULL,
  x_handle                     TEXT NOT NULL,
  tweet_url                    TEXT NOT NULL,
  ticket_count                 SMALLINT NOT NULL CHECK (ticket_count IN (1, 2)),
  balance_base_units_at_entry  BIGINT NOT NULL,
  verified_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_email, day_utc)
);
CREATE INDEX freelottery_entries_day_idx ON freelottery_entries (day_utc, verified_at);

-- 3. One row per drawn day, even empty days. Winner cols are NULL when
-- status='empty'. blockhash + slot record the Solana entropy used for the
-- draw so anyone can re-verify. mint_credited_at and on_chain_signature
-- are filled in by the credit + bridge steps.
CREATE TABLE freelottery_draws (
  day_utc              DATE PRIMARY KEY,
  drawn_at             TIMESTAMPTZ NOT NULL,
  solana_slot          BIGINT,
  solana_blockhash     TEXT,
  total_tickets        INT NOT NULL,
  winner_email         TEXT REFERENCES users(email),
  winner_x_handle      TEXT,
  prize_base_units     BIGINT NOT NULL,
  mint_credited_at     TIMESTAMPTZ,
  on_chain_signature   TEXT,
  status               TEXT NOT NULL DEFAULT 'ok'
    CHECK (status IN ('ok','empty','pending_blockhash')),
  CHECK ((status = 'ok') = (winner_email IS NOT NULL))
);
