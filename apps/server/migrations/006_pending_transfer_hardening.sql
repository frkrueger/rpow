ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_idempotency_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS transfers_sender_idempotency_key_idx
  ON transfers(sender_email, idempotency_key);

ALTER TABLE pending_transfers DROP CONSTRAINT IF EXISTS pending_transfers_idempotency_key_key;
ALTER TABLE pending_transfers ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS pending_transfers_sender_idempotency_key_idx
  ON pending_transfers(sender_email, idempotency_key);

CREATE TABLE IF NOT EXISTS pending_transfer_tokens (
  pending_transfer_id UUID NOT NULL REFERENCES pending_transfers(id) ON DELETE CASCADE,
  token_id UUID NOT NULL REFERENCES tokens(id),
  PRIMARY KEY (pending_transfer_id, token_id)
);

CREATE INDEX IF NOT EXISTS pending_transfer_tokens_token_idx
  ON pending_transfer_tokens(token_id);

-- Best-effort recovery for pre-006 pending transfers. The old schema burned
-- sender tokens without recording which token ids funded each pending claim.
-- Reconstruct that link for still-unclaimed rows by pairing each sender's
-- unclaimed pending slots with invalidated tokens that have not already been
-- reissued as parents of child tokens.
WITH pending_slots AS (
  SELECT
    p.id AS pending_transfer_id,
    p.sender_email,
    row_number() OVER (
      PARTITION BY p.sender_email
      ORDER BY p.created_at, p.id, slot.n
    ) AS rn
  FROM pending_transfers p
  CROSS JOIN LATERAL generate_series(1, p.amount) AS slot(n)
  WHERE p.claimed_at IS NULL
    AND p.canceled_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pending_transfer_tokens existing
      WHERE existing.pending_transfer_id = p.id
    )
),
available_tokens AS (
  SELECT
    t.id AS token_id,
    t.owner_email,
    row_number() OVER (
      PARTITION BY t.owner_email
      ORDER BY t.invalidated_at NULLS LAST, t.issued_at, t.id
    ) AS rn
  FROM tokens t
  WHERE t.state = 'INVALIDATED'
    AND NOT EXISTS (
      SELECT 1 FROM pending_transfer_tokens existing
      WHERE existing.token_id = t.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM tokens child
      WHERE child.parent_token_id = t.id
    )
)
INSERT INTO pending_transfer_tokens (pending_transfer_id, token_id)
SELECT ps.pending_transfer_id, at.token_id
FROM pending_slots ps
JOIN available_tokens at
  ON at.owner_email = ps.sender_email
 AND at.rn = ps.rn
ON CONFLICT DO NOTHING;
