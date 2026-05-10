CREATE TABLE IF NOT EXISTS user_balances (
  owner_email TEXT PRIMARY KEY,
  valid_balance BIGINT NOT NULL DEFAULT 0 CHECK (valid_balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO user_balances(owner_email, valid_balance)
SELECT owner_email, coalesce(sum(value), 0)::bigint
FROM tokens
WHERE state='VALID'
GROUP BY owner_email
ON CONFLICT (owner_email) DO UPDATE
  SET valid_balance = EXCLUDED.valid_balance,
      updated_at = now();

INSERT INTO user_balances(owner_email, valid_balance)
SELECT email, 0 FROM users
ON CONFLICT (owner_email) DO NOTHING;

CREATE INDEX IF NOT EXISTS user_balances_valid_balance_idx
  ON user_balances(valid_balance DESC)
  WHERE valid_balance > 0;

CREATE INDEX IF NOT EXISTS tokens_root_issued_at_idx
  ON tokens(issued_at)
  WHERE parent_token_id IS NULL;

CREATE INDEX IF NOT EXISTS tokens_issued_at_idx
  ON tokens(issued_at);

CREATE INDEX IF NOT EXISTS tokens_invalidated_at_idx
  ON tokens(invalidated_at)
  WHERE invalidated_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS transfers_created_at_idx
  ON transfers(created_at);

CREATE INDEX IF NOT EXISTS users_created_at_idx
  ON users(created_at);

CREATE INDEX IF NOT EXISTS challenges_issued_at_idx
  ON challenges(issued_at);
