CREATE TABLE IF NOT EXISTS email_unsubscribes (
  email TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'all',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
