-- Speed up /me's transfer SUMs. Without these, every /me call did a
-- Sequential Scan on transfers (~100K rows on prod) for both the
-- sender and recipient totals. With the indexes, these become index
-- lookups (~1ms vs 113ms).
--
-- Created CONCURRENTLY on prod via psql before this migration to avoid
-- blocking writes; IF NOT EXISTS makes the migration idempotent.

CREATE INDEX IF NOT EXISTS transfers_sender_email_idx ON transfers(sender_email);
CREATE INDEX IF NOT EXISTS transfers_recipient_email_idx ON transfers(recipient_email);
