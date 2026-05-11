-- 016_trivia.sql
-- RPOW Trivia: PVP feature parallel to gladiator. Same arena-with-bankroll
-- shape, but instead of a coin flip each match is a 10-second multiple-choice
-- trivia race. See docs/superpowers/specs/2026-05-11-trivia-pvp-design.md.

-- 1. Trivia question cache. Populated by the apps/server/src/trivia/questions.ts
-- module pulling batches from opentdb.com.
CREATE TABLE trivia_questions (
  id            UUID PRIMARY KEY,
  category      TEXT NOT NULL,
  difficulty    TEXT NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  question      TEXT NOT NULL,
  correct_idx   INT NOT NULL CHECK (correct_idx >= 0 AND correct_idx < 4),
  choices       TEXT[] NOT NULL CHECK (array_length(choices, 1) = 4),
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trivia_questions_fetched_idx ON trivia_questions(fetched_at);

-- 2. Active and closed trivia arena sessions.
CREATE TABLE trivia_sessions (
  id                              UUID PRIMARY KEY,
  account_email                   TEXT NOT NULL REFERENCES users(email),
  bet_base_units                  BIGINT NOT NULL CHECK (bet_base_units > 0),
  bankroll_initial_base_units     BIGINT NOT NULL CHECK (bankroll_initial_base_units > 0),
  bankroll_remaining_base_units   BIGINT NOT NULL CHECK (bankroll_remaining_base_units >= 0),
  matches_won                     INT NOT NULL DEFAULT 0,
  matches_lost                    INT NOT NULL DEFAULT 0,
  status                          TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  opened_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_match_at                   TIMESTAMPTZ,
  closed_at                       TIMESTAMPTZ,
  CHECK (bankroll_initial_base_units % bet_base_units = 0)
);

CREATE UNIQUE INDEX trivia_sessions_one_open_per_user
  ON trivia_sessions (account_email) WHERE status = 'OPEN';

CREATE INDEX trivia_sessions_open_lobby_idx
  ON trivia_sessions (opened_at DESC) WHERE status = 'OPEN';

CREATE INDEX trivia_sessions_sweeper_idx
  ON trivia_sessions (COALESCE(last_match_at, opened_at)) WHERE status = 'OPEN';

-- 3. Per-match audit (signed once resolved).
CREATE TABLE trivia_matches (
  id                       UUID PRIMARY KEY,
  offerer_session_id       UUID NOT NULL REFERENCES trivia_sessions(id),
  offerer_email            TEXT NOT NULL,
  challenger_email         TEXT NOT NULL,
  bet_base_units           BIGINT NOT NULL CHECK (bet_base_units > 0),
  question_id              UUID NOT NULL REFERENCES trivia_questions(id),
  state                    TEXT NOT NULL CHECK (state IN ('ACTIVE','RESOLVED')),
  deadline_at              TIMESTAMPTZ NOT NULL,
  offerer_choice_idx       INT CHECK (offerer_choice_idx IS NULL OR (offerer_choice_idx >= 0 AND offerer_choice_idx < 4)),
  offerer_answered_at      TIMESTAMPTZ,
  challenger_choice_idx    INT CHECK (challenger_choice_idx IS NULL OR (challenger_choice_idx >= 0 AND challenger_choice_idx < 4)),
  challenger_answered_at   TIMESTAMPTZ,
  winner_email             TEXT,
  signature                BYTEA,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at              TIMESTAMPTZ,
  CHECK ((state = 'RESOLVED') = (winner_email IS NOT NULL AND signature IS NOT NULL AND resolved_at IS NOT NULL))
);

CREATE INDEX trivia_matches_offerer_idx
  ON trivia_matches(offerer_email, created_at DESC);
CREATE INDEX trivia_matches_challenger_idx
  ON trivia_matches(challenger_email, created_at DESC);
CREATE INDEX trivia_matches_recent_idx
  ON trivia_matches(created_at DESC) WHERE state = 'RESOLVED';
CREATE UNIQUE INDEX trivia_matches_one_active_per_session
  ON trivia_matches (offerer_session_id) WHERE state = 'ACTIVE';

-- 4. Global trivia chat (parallel to gladiator_chat_messages)
CREATE TABLE trivia_chat_messages (
  id            UUID PRIMARY KEY,
  account_email TEXT REFERENCES users(email),
  x_handle      TEXT,
  kind          TEXT NOT NULL DEFAULT 'USER' CHECK (kind IN ('USER','SYSTEM')),
  body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 280),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'USER') = (account_email IS NOT NULL))
);
CREATE INDEX trivia_chat_recent_idx ON trivia_chat_messages(created_at DESC);
