-- Read-only stats query indexes; balances remain maintained by migration 036.
CREATE INDEX IF NOT EXISTS tokens_root_issued_at_idx
  ON tokens(issued_at)
  WHERE parent_token_id IS NULL AND NOT is_change;

CREATE INDEX IF NOT EXISTS tokens_issued_at_idx
  ON tokens(issued_at);

CREATE INDEX IF NOT EXISTS transfers_created_at_idx
  ON transfers(created_at);

CREATE INDEX IF NOT EXISTS users_created_at_idx
  ON users(created_at);

CREATE INDEX IF NOT EXISTS challenges_issued_at_idx
  ON challenges(issued_at);
