-- 035_hashlocks.sql
-- Hash-time-locked transfers (HTLCs) for atomic cross-node settlement.
-- Sender locks tokens under a SHA-256 hash; recipient claims by revealing
-- the preimage; sender can refund after expiry. Standard HTLC semantics.

-- 1. Expand tokens.state to include HASHLOCKED.
ALTER TABLE tokens DROP CONSTRAINT tokens_state_check;
ALTER TABLE tokens ADD CONSTRAINT tokens_state_check
  CHECK (state IN ('VALID','INVALIDATED','LOCKED_FOR_BRIDGE','WRAPPED','HASHLOCKED'));

-- 2. Hashlock transfer records.
CREATE TABLE hashlocked_transfers (
  id               UUID PRIMARY KEY,
  sender_email     TEXT NOT NULL,
  recipient_email  TEXT NOT NULL,
  amount           BIGINT NOT NULL CHECK (amount > 0),
  hash_h           BYTEA NOT NULL CHECK (octet_length(hash_h) = 32),
  idempotency_key  TEXT NOT NULL UNIQUE,
  timeout_seconds  INT NOT NULL DEFAULT 14400,
  expires_at       TIMESTAMPTZ NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('PENDING','CLAIMED','REFUNDED')),
  preimage         BYTEA CHECK (preimage IS NULL OR octet_length(preimage) = 32),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at       TIMESTAMPTZ,
  refunded_at      TIMESTAMPTZ
);
CREATE INDEX hl_recipient_idx ON hashlocked_transfers(recipient_email, state);
CREATE INDEX hl_sender_idx    ON hashlocked_transfers(sender_email, state);
CREATE INDEX hl_expires_idx   ON hashlocked_transfers(expires_at)
  WHERE state = 'PENDING';

-- 3. Link tokens to the hashlock that locked them.
ALTER TABLE tokens ADD COLUMN hashlock_id UUID REFERENCES hashlocked_transfers(id);
CREATE INDEX tokens_hashlock_idx ON tokens(hashlock_id)
  WHERE hashlock_id IS NOT NULL;
