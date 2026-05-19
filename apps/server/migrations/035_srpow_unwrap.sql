-- apps/server/migrations/035_srpow_unwrap.sql
-- Adds per-step server-initiated signatures for the unwrap flow + a partial
-- UNIQUE index on the user-submitted inbound transfer sig.
--
-- See docs/superpowers/specs/2026-05-18-srpow-unwrap-design.md.

ALTER TABLE srpow_wrap_events ADD COLUMN swap_signature TEXT;
ALTER TABLE srpow_wrap_events ADD COLUMN burn_signature TEXT;

-- Each inbound transfer sig credits at most one unwrap.
CREATE UNIQUE INDEX srpow_unwrap_inbound_sig_unique
  ON srpow_wrap_events(solana_signature)
  WHERE direction='UNWRAP' AND solana_signature IS NOT NULL;

-- Accounting counter for total SRPOW burned via the unwrap path (excludes
-- the 5% fee portion that went through Jupiter). 128 shards to match the
-- supply counter contention profile.
INSERT INTO app_counters (name, value, shard)
SELECT 'unwrap_fee_burned_srpow_base_units', 0, gs FROM generate_series(0, 127) AS gs
ON CONFLICT (name, shard) DO NOTHING;
