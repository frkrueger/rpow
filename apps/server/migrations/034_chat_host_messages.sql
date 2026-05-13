-- ============================================================
-- Migration 034: support for AI host messages.
--   1. is_host column on chat_room_messages flags messages authored by
--      a room's host persona (vs a real X-verified user).
--   2. Seed a system "user" row per host slug so the chat_room_messages
--      FK on user_email (users.email) is satisfied for host inserts.
--      Hosts identify in user_email as '__host__:<room_slug>'.
-- ============================================================

ALTER TABLE chat_room_messages
  ADD COLUMN is_host BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX idx_chat_room_messages_room_host
  ON chat_room_messages(room_slug, is_host);

INSERT INTO users (email)
  SELECT '__host__:' || slug FROM chat_rooms
  ON CONFLICT (email) DO NOTHING;
