-- ============================================================
-- Migration 031: RPOW ChatRooms.
-- Slice 1 creates the full schema (rooms, messages, DMs, blocks, bans,
-- mutes, tips) and seeds the initial rooms with their AI host metadata.
-- Slice 1 wires only GET /api/chat/rooms — host runtime (slice 2) and
-- tip plumbing (slice 3) come later but share this schema.
-- See docs/superpowers/specs/2026-05-12-rpow-chatrooms-design.md.
-- ============================================================

CREATE TABLE chat_rooms (
  slug             TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  category         TEXT NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  disabled         BOOLEAN NOT NULL DEFAULT false,
  host_name        TEXT NOT NULL,
  host_persona     TEXT NOT NULL,
  host_avatar_url  TEXT,
  host_enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_rooms_category_sort ON chat_rooms(category, sort_order);

CREATE TABLE chat_room_messages (
  id           BIGSERIAL PRIMARY KEY,
  room_slug    TEXT NOT NULL REFERENCES chat_rooms(slug),
  user_email   TEXT NOT NULL REFERENCES users(email),
  x_handle     TEXT NOT NULL,
  x_avatar_url TEXT,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX idx_chat_room_messages_room_time ON chat_room_messages(room_slug, created_at DESC);

CREATE TABLE chat_dm_threads (
  id            BIGSERIAL PRIMARY KEY,
  user_a_email  TEXT NOT NULL REFERENCES users(email),
  user_b_email  TEXT NOT NULL REFERENCES users(email),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_a_email, user_b_email)
);

CREATE TABLE chat_dm_messages (
  id            BIGSERIAL PRIMARY KEY,
  thread_id     BIGINT NOT NULL REFERENCES chat_dm_threads(id),
  sender_email  TEXT NOT NULL REFERENCES users(email),
  x_handle      TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX idx_chat_dm_messages_thread_time ON chat_dm_messages(thread_id, created_at DESC);

CREATE TABLE chat_user_blocks (
  blocker_email  TEXT NOT NULL REFERENCES users(email),
  blocked_email  TEXT NOT NULL REFERENCES users(email),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_email, blocked_email)
);

CREATE TABLE chat_bans (
  user_email   TEXT PRIMARY KEY REFERENCES users(email),
  reason       TEXT,
  banned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  banned_by    TEXT NOT NULL
);

CREATE TABLE chat_room_mutes (
  room_slug    TEXT NOT NULL REFERENCES chat_rooms(slug),
  user_email   TEXT NOT NULL REFERENCES users(email),
  muted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  muted_until  TIMESTAMPTZ NOT NULL,
  muted_by     TEXT NOT NULL,
  reason       TEXT,
  PRIMARY KEY (room_slug, user_email)
);
CREATE INDEX idx_chat_room_mutes_until ON chat_room_mutes(muted_until);

CREATE TABLE chat_tips (
  id                 BIGSERIAL PRIMARY KEY,
  room_slug          TEXT NOT NULL REFERENCES chat_rooms(slug),
  host_name          TEXT NOT NULL,
  message_id         BIGINT NOT NULL REFERENCES chat_room_messages(id),
  recipient_email    TEXT NOT NULL REFERENCES users(email),
  recipient_x_handle TEXT NOT NULL,
  base_units         BIGINT NOT NULL,
  reason             TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_tips_created_at ON chat_tips(created_at DESC);
CREATE INDEX idx_chat_tips_recipient ON chat_tips(recipient_email, created_at DESC);

INSERT INTO chat_rooms (slug, title, description, category, sort_order, host_name, host_persona) VALUES
  ('general',     '#general',     'Catch-all lounge.',                       'ORIGINALS',   10, 'Vint Cerf',     'AI host inspired by the internet pioneer. Welcoming, steers tangents back to topic, asks open-ended questions.'),
  ('rpow',        '#rpow',        'rpow2 announcements + meta.',             'ORIGINALS',   20, 'Hal Finney',    'AI host inspired by Hal Finney. Thoughtful, technical, cypherpunk-historical. Explains primitives carefully.'),
  ('technology',  '#technology',  'Broad tech talk.',                        'TECH',        10, 'Ada Lovelace',  'AI host inspired by the first programmer. Curious about how things work; loves design diagrams.'),
  ('ai',          '#ai',          'AI, LLMs, agents.',                       'TECH',        20, 'Alan Turing',   'AI host inspired by Turing. Probes assumptions, asks "what would the test be?".'),
  ('programming', '#programming', 'Code, languages, tooling.',               'TECH',        30, 'The Hacker',    'Fictional AI host. Pragmatic, opinionated about tooling, comfortable in any language.'),
  ('web3',        '#web3',        'Decentralized web, identity, infra.',     'TECH',        40, 'The Architect', 'Fictional AI host. Systems-thinker. Skeptical of hype, asks about user value.'),
  ('bitcoin',     '#bitcoin',     'Bitcoin + Lightning.',                    'CRYPTO',      10, 'Satoshi',       'AI host inspired by the Bitcoin pseudonym. Terse, prefers source over speculation.'),
  ('solana',      '#solana',      'Solana ecosystem.',                       'CRYPTO',      20, 'Anatoly',       'AI host inspired by Anatoly Yakovenko. Performance-minded, fast-takes on validators and tps.'),
  ('ethereum',    '#ethereum',    'Ethereum, EVM, L2s.',                     'CRYPTO',      30, 'The Founder',   'Fictional AI host. Long-arc thinker about Ethereum''s evolution; references EIPs.'),
  ('trading',     '#trading',     'Markets, charts, OTC.',                   'CRYPTO',      40, 'The Trader',    'Fictional AI host. Cool-headed about volatility; talks position-sizing, not predictions.'),
  ('gen-z',       '#gen-z',       'Gen Z lounge (~ages 13-28).',             'GENERATIONS', 10, 'Zee',           'Fictional Gen-Z AI host. Internet-fluent, low patience for grandstanding.'),
  ('millennials', '#millennials', 'Millennials lounge (~ages 29-44).',       'GENERATIONS', 20, 'Avery',         'Fictional Millennial AI host. Nostalgic about early-internet culture, dry humor.'),
  ('gen-x',       '#gen-x',       'Gen X lounge (~ages 45-60).',             'GENERATIONS', 30, 'Marlow',        'Fictional Gen-X AI host. Wry, skeptical, references 90s and 00s.'),
  ('boomers',     '#boomers',     'Boomers lounge (~ages 61+).',             'GENERATIONS', 40, 'Hank',          'Fictional Boomer AI host. Generous with context, references the long arc.'),
  ('music',       '#music',       'Music — listening, making, recommending.', 'CULTURE',     10, 'Riff',          'Fictional AI host. Eclectic taste; equally at home with jazz and grime.'),
  ('movies',      '#movies',      'Films & TV.',                             'CULTURE',     20, 'Reel',          'Fictional AI host. Talks craft (cinematography, editing), not box office.'),
  ('gaming',      '#gaming',      'Video games + tabletop.',                 'CULTURE',     30, 'Pixel',          'Fictional AI host. Loves a good systems-design rant; respects retro.'),
  ('books',       '#books',       'Reading list, recommendations.',          'CULTURE',     40, 'Page',           'Fictional AI host. Quiet, careful, asks what you''ve been reading.'),
  ('sports',      '#sports',      'All sports, all leagues.',                'CULTURE',     50, 'Coach',          'Fictional AI host. Stats-curious, hates hot takes.'),
  ('random',      '#random',      'Anything goes.',                          'LOUNGE',      10, 'The Wanderer',   'Fictional AI host. Wandering curiosity, asks "what''s on your mind?".'),
  ('late-night',  '#late-night',  'Quiet-hours conversation.',               'LOUNGE',      20, 'Owl',            'Fictional AI host. Calm, thoughtful, low-key. Speaks slower.');
