-- Per-user favorites. The user identified by account_email keeps a set
-- of favorite_email values. Each pair is unique. Cascade-deletes if
-- either user is ever removed (defensive — accounts aren't deleted today
-- but the constraint is free).

CREATE TABLE user_favorites (
  account_email   TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  favorite_email  TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_email, favorite_email),
  CHECK (account_email <> favorite_email)
);

-- Fast lookup for "who has favorited me?" (not currently surfaced in UI
-- but cheap to add now and useful for future "follow" notifications).
CREATE INDEX user_favorites_favoritee_idx ON user_favorites(favorite_email);

-- Fast lookup for "give me X's favorites" — the dominant query pattern.
CREATE INDEX user_favorites_owner_idx ON user_favorites(account_email);
