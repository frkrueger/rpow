CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS magic_links (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS magic_links_email_idx ON magic_links(email);

CREATE TABLE IF NOT EXISTS challenges (
  id UUID PRIMARY KEY,
  user_email TEXT NOT NULL,
  nonce_prefix BYTEA NOT NULL,
  difficulty_bits INT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS challenges_user_idx ON challenges(user_email);

CREATE TABLE IF NOT EXISTS tokens (
  id UUID PRIMARY KEY,
  owner_email TEXT NOT NULL,
  value INT NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('VALID','INVALIDATED')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  invalidated_at TIMESTAMPTZ,
  parent_token_id UUID REFERENCES tokens(id),
  server_sig BYTEA NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_owner_state_idx ON tokens(owner_email, state);

CREATE TABLE IF NOT EXISTS transfers (
  id UUID PRIMARY KEY,
  sender_email TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  amount INT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
