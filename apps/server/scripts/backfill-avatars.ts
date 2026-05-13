#!/usr/bin/env tsx
// scripts/backfill-avatars.ts
//
// One-shot script: resolve every X-verified user's profile_image_url via
// X API v2 (batched 100-at-a-time), fetch the avatar bytes from twimg,
// and populate the avatar_cache table. Idempotent — re-running just
// refreshes any handles whose pfp changed.
//
// Usage (on the VPS):
//   sudo -u rpow bash -c 'set -a; . /etc/rpow/server.env; set +a; \
//     tsx /opt/rpow/repo/apps/server/scripts/backfill-avatars.ts'
//
// Requires X_BEARER_TOKEN + DATABASE_URL in the environment.

import { createPool } from '../src/db.js';

const X_API_BASE = 'https://api.twitter.com/2';
const BATCH_SIZE = 100;        // X API users/by max
const FETCH_TIMEOUT_MS = 10_000;

interface XUser {
  id: string;
  username: string;
  profile_image_url?: string;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!databaseUrl) throw new Error('DATABASE_URL required');
  if (!bearerToken) throw new Error('X_BEARER_TOKEN required');

  const pool = createPool(databaseUrl);

  console.log('reading verified X handles from users table');
  const { rows } = await pool.query<{ x_handle: string }>(
    `SELECT x_handle FROM users WHERE x_handle IS NOT NULL ORDER BY x_handle ASC`,
  );
  const handles = rows.map(r => r.x_handle);
  console.log(`found ${handles.length} handle(s)`);

  let ok = 0;
  let missing = 0;
  let fetchFail = 0;

  for (let i = 0; i < handles.length; i += BATCH_SIZE) {
    const batch = handles.slice(i, i + BATCH_SIZE);
    console.log(`batch ${i / BATCH_SIZE + 1}: ${batch.length} handle(s) (offset ${i})`);

    const url = `${X_API_BASE}/users/by?usernames=${batch.map(encodeURIComponent).join(',')}&user.fields=profile_image_url`;
    const r = await fetch(url, { headers: { authorization: `Bearer ${bearerToken}` } });
    if (!r.ok) {
      const body = await r.text();
      console.error(`x api error ${r.status}: ${body.slice(0, 200)}`);
      // Mark every handle in this batch as missing so the proxy doesn't
      // hammer X API for them on next page load.
      for (const h of batch) await persistMissing(pool, h);
      missing += batch.length;
      continue;
    }
    const data = await r.json() as { data?: XUser[]; errors?: unknown[] };

    // X API returns matched users in `data`. Unmatched handles end up in
    // `errors` — mark them missing.
    const resolved = new Map<string, XUser>();
    for (const u of data.data ?? []) resolved.set(u.username.toLowerCase(), u);
    for (const handle of batch) {
      const user = resolved.get(handle.toLowerCase());
      if (!user?.profile_image_url) {
        await persistMissing(pool, handle);
        missing++;
        continue;
      }
      const hiRes = user.profile_image_url.replace(/_normal(\.\w+)(\?.*)?$/, '_400x400$1');
      const fetched = await fetchBytes(hiRes);
      if (!fetched) {
        await persistMissing(pool, handle);
        fetchFail++;
        continue;
      }
      await pool.query(
        `INSERT INTO avatar_cache (handle, content_type, bytes, fetched_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (handle) DO UPDATE
             SET content_type = EXCLUDED.content_type,
                 bytes        = EXCLUDED.bytes,
                 fetched_at   = EXCLUDED.fetched_at`,
        [handle, fetched.contentType, fetched.bytes],
      );
      ok++;
    }
  }

  console.log(`done. ok=${ok} missing=${missing} fetch_fail=${fetchFail}`);
  await pool.end();
}

async function fetchBytes(url: string): Promise<{ contentType: string; bytes: Buffer } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!r.ok) return null;
    const contentType = r.headers.get('content-type') ?? 'image/jpeg';
    const bytes = Buffer.from(await r.arrayBuffer());
    return { contentType, bytes };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function persistMissing(pool: ReturnType<typeof createPool>, handle: string) {
  await pool.query(
    `INSERT INTO avatar_cache (handle, content_type, bytes, fetched_at)
       VALUES ($1, '__missing__', '\\x', now())
       ON CONFLICT (handle) DO UPDATE
         SET content_type = '__missing__',
             bytes        = '\\x',
             fetched_at   = now()`,
    [handle],
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
