-- 014_gladiator.sql
-- RPOW Gladiator Arena: PvP coin-flip feature with X handle verification.
-- See docs/superpowers/specs/2026-05-10-gladiator-arena-design.md.

-- 1. Extend users with X identity
ALTER TABLE users
  ADD COLUMN x_handle TEXT,
  ADD COLUMN x_handle_verified_at TIMESTAMPTZ,
  ADD COLUMN x_avatar_url TEXT;

CREATE UNIQUE INDEX users_x_handle_lower_uniq
  ON users (LOWER(x_handle)) WHERE x_handle IS NOT NULL;

-- 2. Pending X verification (ephemeral; one row per user at most)
CREATE TABLE x_verification_codes (
  account_email   TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
  pending_handle  TEXT NOT NULL,
  code            TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Active and closed arena sessions
CREATE TABLE gladiator_sessions (
  id                              UUID PRIMARY KEY,
  account_email                   TEXT NOT NULL REFERENCES users(email),
  bet_base_units                  BIGINT NOT NULL CHECK (bet_base_units > 0),
  bankroll_initial_base_units     BIGINT NOT NULL CHECK (bankroll_initial_base_units > 0),
  bankroll_remaining_base_units   BIGINT NOT NULL CHECK (bankroll_remaining_base_units >= 0),
  flips_won                       INT NOT NULL DEFAULT 0,
  flips_lost                      INT NOT NULL DEFAULT 0,
  status                          TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  opened_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_flip_at                    TIMESTAMPTZ,                       -- updated on each flip; null until first flip
  closed_at                       TIMESTAMPTZ,
  CHECK (bankroll_initial_base_units % bet_base_units = 0)
);

CREATE UNIQUE INDEX gladiator_sessions_one_open_per_user
  ON gladiator_sessions (account_email) WHERE status = 'OPEN';

CREATE INDEX gladiator_sessions_open_lobby_idx
  ON gladiator_sessions (opened_at DESC) WHERE status = 'OPEN';

CREATE INDEX gladiator_sessions_sweeper_idx
  ON gladiator_sessions (COALESCE(last_flip_at, opened_at)) WHERE status = 'OPEN';

-- 4. Per-flip audit (signed)
CREATE TABLE gladiator_flips (
  id                      UUID PRIMARY KEY,
  offerer_session_id      UUID NOT NULL REFERENCES gladiator_sessions(id),
  challenger_session_id   UUID REFERENCES gladiator_sessions(id),    -- NULL = drop-in challenger
  offerer_email           TEXT NOT NULL,
  challenger_email        TEXT NOT NULL,
  bet_base_units          BIGINT NOT NULL CHECK (bet_base_units > 0),
  winner_email            TEXT NOT NULL,                              -- offerer_email OR challenger_email
  random_value_hex        TEXT NOT NULL,
  signature               BYTEA NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX gladiator_flips_offerer_idx    ON gladiator_flips(offerer_email, created_at DESC);
CREATE INDEX gladiator_flips_challenger_idx ON gladiator_flips(challenger_email, created_at DESC);
CREATE INDEX gladiator_flips_created_at_idx ON gladiator_flips(created_at DESC);

-- 5. Global arena chat
CREATE TABLE gladiator_chat_messages (
  id            UUID PRIMARY KEY,
  account_email TEXT REFERENCES users(email),                         -- NULL for SYSTEM rows
  x_handle      TEXT,                                                 -- snapshot at post time
  kind          TEXT NOT NULL DEFAULT 'USER' CHECK (kind IN ('USER','SYSTEM')),
  body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 280),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'USER') = (account_email IS NOT NULL))
);
CREATE INDEX gladiator_chat_recent_idx ON gladiator_chat_messages(created_at DESC);
