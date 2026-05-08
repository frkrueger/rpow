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
-- Reconstruct missing links by pairing each sender's pending slots with
-- invalidated tokens that have not already been reissued as parents of child
-- tokens. Live unclaimed rows are prioritized over already-claimed rows, and
-- expired rows only receive leftover tokens.
WITH existing_links AS (
  SELECT pending_transfer_id, count(*)::int AS linked
  FROM pending_transfer_tokens
  GROUP BY pending_transfer_id
),
pending_slots AS (
  SELECT
    p.id AS pending_transfer_id,
    p.sender_email,
    row_number() OVER (
      PARTITION BY p.sender_email
      ORDER BY
        CASE
          WHEN p.claimed_at IS NULL AND p.expires_at > now() THEN 0
          WHEN p.claimed_at IS NOT NULL THEN 1
          ELSE 2
        END,
        COALESCE(p.claimed_at, p.expires_at),
        p.created_at,
        p.id,
        slot.n
    ) AS rn
  FROM pending_transfers p
  LEFT JOIN existing_links el ON el.pending_transfer_id = p.id
  CROSS JOIN LATERAL generate_series(coalesce(el.linked, 0) + 1, p.amount) AS slot(n)
  WHERE p.canceled_at IS NULL
    AND coalesce(el.linked, 0) < p.amount
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
),
inserted_links AS (
  INSERT INTO pending_transfer_tokens (pending_transfer_id, token_id)
  SELECT ps.pending_transfer_id, at.token_id
  FROM pending_slots ps
  JOIN available_tokens at
    ON at.owner_email = ps.sender_email
   AND at.rn = ps.rn
  ON CONFLICT DO NOTHING
  RETURNING pending_transfer_id, token_id
),
-- Legacy claims before this migration minted fresh root tokens to recipients
-- and bumped app_counters.minted_supply. Where the completed claim has an
-- unambiguous set of recipient root tokens near the claim transaction, convert
-- those roots into children of the recovered sender tokens and subtract the
-- remediated count from the maintained root-supply counter. Only links inserted
-- by this statement are eligible, leaving already-hardened claims untouched.
claimed_links AS (
  SELECT
    p.id,
    p.recipient_email,
    p.amount,
    p.claimed_at,
    tr.created_at AS transfer_created_at
  FROM pending_transfers p
  JOIN transfers tr
    ON tr.sender_email = p.sender_email
   AND tr.recipient_email = p.recipient_email
   AND tr.amount = p.amount
   AND tr.idempotency_key = 'claim:' || p.id::text
  JOIN (
    SELECT pending_transfer_id, count(*)::int AS linked
    FROM inserted_links
    GROUP BY pending_transfer_id
  ) link_count
    ON link_count.pending_transfer_id = p.id
   AND link_count.linked = p.amount
  WHERE p.claimed_at IS NOT NULL
    AND p.canceled_at IS NULL
),
eligible_roots AS (
  SELECT
    cl.id AS pending_transfer_id,
    cl.amount,
    t.id AS root_token_id,
    row_number() OVER (
      PARTITION BY cl.id
      ORDER BY t.issued_at, t.id
    ) AS rn,
    count(*) OVER (PARTITION BY cl.id) AS root_count
  FROM claimed_links cl
  JOIN tokens t
    ON t.owner_email = cl.recipient_email
   AND t.parent_token_id IS NULL
   AND t.issued_at >= LEAST(cl.claimed_at, cl.transfer_created_at) - interval '10 minutes'
   AND t.issued_at <= GREATEST(cl.claimed_at, cl.transfer_created_at) + interval '10 minutes'
),
claim_roots AS (
  SELECT pending_transfer_id, root_token_id, rn
  FROM eligible_roots
  WHERE root_count = amount
),
source_tokens AS (
  SELECT
    il.pending_transfer_id,
    il.token_id,
    row_number() OVER (
      PARTITION BY il.pending_transfer_id
      ORDER BY il.token_id
    ) AS rn
  FROM inserted_links il
  JOIN claimed_links cl ON cl.id = il.pending_transfer_id
),
assigned_roots AS (
  SELECT cr.root_token_id, st.token_id AS source_token_id
  FROM claim_roots cr
  JOIN source_tokens st
    ON st.pending_transfer_id = cr.pending_transfer_id
   AND st.rn = cr.rn
),
updated_roots AS (
  UPDATE tokens root
  SET parent_token_id = assigned.source_token_id
  FROM assigned_roots assigned
  WHERE root.id = assigned.root_token_id
    AND root.parent_token_id IS NULL
  RETURNING root.id
),
patched AS (
  SELECT count(*)::bigint AS n FROM updated_roots
)
UPDATE app_counters
SET value = GREATEST(0::bigint, app_counters.value - patched.n)
FROM patched
WHERE app_counters.name = 'minted_supply'
  AND patched.n > 0;
