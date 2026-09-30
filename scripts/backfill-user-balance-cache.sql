-- backfill-user-balance-cache.sql
-- One-time backfill for 036_user_balance_cache migration.
-- Run AFTER deploying the migration (trigger must be live first).
-- Takes one sequential scan of the tokens table (~5-20 min on 159 GB).
-- Safe to run while the server is live; trigger handles concurrent writes.
--
-- Usage:
--   sudo -u postgres psql -d rpow -f scripts/backfill-user-balance-cache.sql

\timing on

\echo 'Backfilling cached_balance, cached_wrapped, cached_minted on users...'

UPDATE users u
SET
  cached_balance = t.balance,
  cached_wrapped = t.wrapped,
  cached_minted  = t.minted
FROM (
  SELECT
    owner_email,
    COALESCE(SUM(value) FILTER (WHERE state = 'VALID'),             0) AS balance,
    COALESCE(SUM(value) FILTER (WHERE state = 'WRAPPED'),           0) AS wrapped,
    COALESCE(SUM(value) FILTER (WHERE parent_token_id IS NULL),     0) AS minted
  FROM tokens
  GROUP BY owner_email
) t
WHERE u.email = t.owner_email;

\echo 'Backfill complete. Verify a few rows:'
SELECT email, cached_balance, cached_wrapped, cached_minted
FROM users
ORDER BY cached_balance DESC
LIMIT 10;
