-- 030_avatar_proxy.sql
-- Stop hotlinking unavatar.io directly. We proxy X (Twitter) avatars
-- through api.rpow2.com and cache the bytes server-side so each handle
-- is fetched from upstream at most once per refresh window.
--
-- 1. New cache table that stores the actual avatar bytes.
-- 2. Backfill users.x_avatar_url to point at the proxy URL instead of
--    unavatar.io directly. xHandle.ts writes new binds in proxy form.

CREATE TABLE avatar_cache (
  handle       TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  bytes        BYTEA NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

UPDATE users
SET x_avatar_url = replace(
  x_avatar_url,
  'https://unavatar.io/twitter/',
  'https://api.rpow2.com/api/avatars/x/'
)
WHERE x_avatar_url LIKE 'https://unavatar.io/twitter/%';
