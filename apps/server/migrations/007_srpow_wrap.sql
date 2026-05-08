-- 007_srpow_wrap.sql

-- Expand tokens.state to include LOCKED_FOR_BRIDGE and WRAPPED.
ALTER TABLE tokens DROP CONSTRAINT tokens_state_check;
ALTER TABLE tokens ADD CONSTRAINT tokens_state_check
  CHECK (state IN ('VALID','INVALIDATED','LOCKED_FOR_BRIDGE','WRAPPED'));

-- 1:1 Phantom binding.
ALTER TABLE users ADD COLUMN solana_wallet TEXT UNIQUE;

-- Wrap/unwrap event log.
CREATE TABLE srpow_wrap_events (
  id UUID PRIMARY KEY,
  user_email TEXT NOT NULL,
  solana_wallet TEXT NOT NULL,
  amount INT NOT NULL CHECK (amount > 0),
  direction TEXT NOT NULL CHECK (direction IN ('WRAP','UNWRAP')),
  status TEXT NOT NULL CHECK (status IN ('PENDING','CONFIRMED','FAILED','REFUNDED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  solana_signature TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX srpow_wrap_events_user_idx ON srpow_wrap_events(user_email);
CREATE INDEX srpow_wrap_events_pending_idx ON srpow_wrap_events(status)
  WHERE status='PENDING';

-- Link tokens to the wrap event that put them in their current state.
ALTER TABLE tokens ADD COLUMN wrap_event_id UUID REFERENCES srpow_wrap_events(id);
CREATE INDEX tokens_wrap_event_idx ON tokens(wrap_event_id) WHERE wrap_event_id IS NOT NULL;

-- Phantom challenge nonces.
CREATE TABLE phantom_challenges (
  nonce UUID PRIMARY KEY,
  user_email TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX phantom_challenges_user_idx ON phantom_challenges(user_email);
