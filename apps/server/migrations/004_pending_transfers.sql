-- Pending transfers: when a sender sends to an email that has no rpow2 account.
-- Tokens are invalidated on the sender side immediately and recorded in
-- pending_transfer_tokens; the recipient receives an email with a one-time
-- claim link. On claim, an account is auto-created and child tokens are
-- reissued to the recipient with parent_token_id pointing at the sender's
-- original tokens.

CREATE TABLE IF NOT EXISTS pending_transfers (
  id UUID PRIMARY KEY,
  sender_email TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  amount INT NOT NULL CHECK (amount > 0),
  idempotency_key TEXT NOT NULL,
  claim_token_hash BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pending_transfer_tokens (
  pending_transfer_id UUID NOT NULL REFERENCES pending_transfers(id) ON DELETE CASCADE,
  token_id UUID NOT NULL REFERENCES tokens(id),
  PRIMARY KEY (pending_transfer_id, token_id)
);

CREATE INDEX IF NOT EXISTS pending_transfer_tokens_token_idx
  ON pending_transfer_tokens(token_id);

CREATE UNIQUE INDEX IF NOT EXISTS pending_transfers_claim_token_hash_idx
  ON pending_transfers(claim_token_hash);

CREATE INDEX IF NOT EXISTS pending_transfers_recipient_idx
  ON pending_transfers(recipient_email, claimed_at);

CREATE INDEX IF NOT EXISTS pending_transfers_sender_idx
  ON pending_transfers(sender_email, claimed_at);
