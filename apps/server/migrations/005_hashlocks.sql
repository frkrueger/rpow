-- Hashlocked transfers: atomic swap primitive.
-- Sender locks tokens under SHA-256 hash H. Recipient claims with preimage P
-- where sha256(P) = H. If unclaimed by expires_at, sender can refund.

ALTER TABLE tokens DROP CONSTRAINT tokens_state_check;
ALTER TABLE tokens ADD CONSTRAINT tokens_state_check
  CHECK (state IN ('VALID', 'INVALIDATED', 'HASHLOCKED'));

CREATE TABLE IF NOT EXISTS hashlocked_transfers (
  id UUID PRIMARY KEY,
  sender_email TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  amount INT NOT NULL CHECK (amount > 0),
  hash_h BYTEA NOT NULL CHECK (octet_length(hash_h) = 32),
  idempotency_key TEXT NOT NULL UNIQUE,
  timeout_seconds INT NOT NULL DEFAULT 14400,
  expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'CLAIMED', 'REFUNDED')),
  preimage BYTEA CHECK (preimage IS NULL OR octet_length(preimage) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ
);

-- Column must be added before the FK can reference the target table.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS hashlock_id UUID REFERENCES hashlocked_transfers(id);

CREATE INDEX IF NOT EXISTS tokens_hashlock_idx
  ON tokens(hashlock_id) WHERE hashlock_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hashlocked_transfers_recipient_idx
  ON hashlocked_transfers(recipient_email, state);
CREATE INDEX IF NOT EXISTS hashlocked_transfers_expires_idx
  ON hashlocked_transfers(expires_at) WHERE state = 'PENDING';
CREATE INDEX IF NOT EXISTS hashlocked_transfers_sender_idx
  ON hashlocked_transfers(sender_email, state);
