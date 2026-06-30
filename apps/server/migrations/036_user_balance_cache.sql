-- 036_user_balance_cache.sql
-- Maintain per-user cached_balance, cached_wrapped, cached_minted on the
-- users table via a trigger on tokens. Eliminates the 159 GB SUM(tokens)
-- hot path in /me that was saturating the DB under bot mining traffic.
--
-- Same pattern as migration 023 (global supply counters via trigger).
-- Trigger uses += / -= deltas so it stays correct under concurrent writes.
-- Backfill is deferred: run scripts/backfill-user-balance-cache.sql
-- separately (one sequential scan, ~5-20 min) before switching /me to
-- read from these columns.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS cached_balance bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cached_wrapped bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cached_minted  bigint NOT NULL DEFAULT 0;

-- Trigger function: maintain per-user cached totals on every token write.
CREATE OR REPLACE FUNCTION maintain_user_balance_cache() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE users SET
      cached_balance = cached_balance + CASE WHEN NEW.state = 'VALID'   THEN NEW.value ELSE 0 END,
      cached_wrapped = cached_wrapped + CASE WHEN NEW.state = 'WRAPPED' THEN NEW.value ELSE 0 END,
      cached_minted  = cached_minted  + CASE WHEN NEW.parent_token_id IS NULL THEN NEW.value ELSE 0 END
    WHERE email = NEW.owner_email;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.state IS DISTINCT FROM NEW.state THEN
    UPDATE users SET
      cached_balance = cached_balance
        - CASE WHEN OLD.state = 'VALID'   THEN OLD.value ELSE 0 END
        + CASE WHEN NEW.state = 'VALID'   THEN NEW.value ELSE 0 END,
      cached_wrapped = cached_wrapped
        - CASE WHEN OLD.state = 'WRAPPED' THEN OLD.value ELSE 0 END
        + CASE WHEN NEW.state = 'WRAPPED' THEN NEW.value ELSE 0 END
    WHERE email = NEW.owner_email;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tokens_maintain_user_balance_cache ON tokens;
CREATE TRIGGER tokens_maintain_user_balance_cache
  AFTER INSERT OR UPDATE ON tokens
  FOR EACH ROW
  EXECUTE FUNCTION maintain_user_balance_cache();
