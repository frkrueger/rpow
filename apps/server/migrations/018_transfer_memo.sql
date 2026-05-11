-- Optional memo on transfers. Used as a free-form context string by clients
-- that integrate RPOW payments into other systems (e.g. games polling
-- /activity for a known recipient and reading the memo to match a transfer
-- to a game session).

ALTER TABLE transfers
  ADD COLUMN memo TEXT NULL
  CHECK (memo IS NULL OR (length(memo) <= 256 AND memo ~ '^[A-Za-z0-9_-]*$'));
