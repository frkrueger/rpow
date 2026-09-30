-- 014_api_keys.sql
-- Long-lived bearer tokens for programmatic API access.
-- One key per email; issuing a new one replaces the existing row.
-- See docs/superpowers/specs/2026-05-10-api-keys-design.md.

CREATE TABLE api_keys (
  email          TEXT        PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
  token_hash     BYTEA       NOT NULL,
  token_prefix   TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX api_keys_token_hash_idx ON api_keys(token_hash);
