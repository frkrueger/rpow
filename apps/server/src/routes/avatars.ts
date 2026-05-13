import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';

const X_API_BASE = 'https://api.twitter.com/2';
const FETCH_TIMEOUT_MS = 5_000;
// X / Twitter handle rules: 1-15 chars, [A-Za-z0-9_]. Anything else is rejected
// to keep the URL space tight and prevent path-traversal-style abuse.
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

// Negative-cache sentinel: when upstream returns non-OK we don't want to
// hammer it on every request. We persist a row with content_type='__missing__'
// and zero bytes, then re-try upstream once the row is older than this TTL.
const MISSING_CONTENT_TYPE = '__missing__';
const MISSING_TTL_HOURS = 24;

/** Server-side X-avatar proxy with persistent Postgres cache.
 *
 *  GET /api/avatars/x/:handle
 *
 *  Lookup order:
 *    1. avatar_cache hit (fresh): serve cached bytes.
 *    2. avatar_cache hit (negative, within TTL): return 404 (browser falls
 *       back to its <img onerror> handler).
 *    3. avatar_cache miss OR stale negative: fetch unavatar.io, store
 *       result (success or failure), serve.
 *
 *  Success rows have no TTL — we never re-fetch a handle whose avatar we
 *  have. Failure rows expire after MISSING_TTL_HOURS so handles that come
 *  back online get retried. */
export async function avatarRoutes(app: FastifyInstance) {
  app.get<{ Params: { handle: string } }>('/api/avatars/x/:handle', async (req, reply) => {
    const { handle } = req.params;

    if (!HANDLE_RE.test(handle)) {
      return sendMissing(reply);
    }

    // 1. Cache lookup. Treat missing-rows older than the TTL as stale.
    const cached = await app.pool.query<{ content_type: string; bytes: Buffer; age_hours: number }>(
      `SELECT content_type, bytes,
              EXTRACT(EPOCH FROM (now() - fetched_at)) / 3600 AS age_hours
         FROM avatar_cache
         WHERE handle = $1`,
      [handle],
    );
    if (cached.rows.length > 0) {
      const row = cached.rows[0]!;
      if (row.content_type !== MISSING_CONTENT_TYPE) {
        return sendImage(reply, row.content_type, row.bytes);
      }
      if (Number(row.age_hours) < MISSING_TTL_HOURS) {
        return sendMissing(reply);
      }
      // Fall through and try upstream again. The INSERT below will overwrite.
    }

    // 2. Upstream fetch via X API → twimg.
    if (!app.config.xBearerToken) {
      // No token configured (dev/test) — cache the miss so we don't keep
      // hitting this path and serve 404.
      await persistMissing(app, handle);
      return sendMissing(reply);
    }
    try {
      const result = await fetchAvatarFromX(handle, app.config.xBearerToken);
      if (!result) {
        await persistMissing(app, handle);
        return sendMissing(reply);
      }
      const { contentType, bytes } = result;

      await app.pool.query(
        `INSERT INTO avatar_cache (handle, content_type, bytes, fetched_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (handle) DO UPDATE
             SET content_type = EXCLUDED.content_type,
                 bytes        = EXCLUDED.bytes,
                 fetched_at   = EXCLUDED.fetched_at`,
        [handle, contentType, bytes],
      );

      return sendImage(reply, contentType, bytes);
    } catch {
      await persistMissing(app, handle);
      return sendMissing(reply);
    }
  });
}

/** Look up profile_image_url via X API, then fetch the bytes from twimg.
 *  Returns null on any failure (handle not found, X API down, image fetch
 *  fails). The caller persists a negative cache row on null. */
export async function fetchAvatarFromX(
  handle: string,
  bearerToken: string,
): Promise<{ contentType: string; bytes: Buffer } | null> {
  const profileUrl = await fetchProfileImageUrl(handle, bearerToken);
  if (!profileUrl) return null;
  // X API returns the _normal (48px) variant. Upgrade to _400x400 for
  // crisp avatar rendering on hi-DPI screens.
  const hiResUrl = profileUrl.replace(/_normal(\.\w+)(\?.*)?$/, '_400x400$1');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(hiResUrl, { signal: controller.signal, redirect: 'follow' });
    if (!r.ok) return null;
    const contentType = r.headers.get('content-type') ?? 'image/jpeg';
    const bytes = Buffer.from(await r.arrayBuffer());
    return { contentType, bytes };
  } finally {
    clearTimeout(timer);
  }
}

/** Single-handle lookup against X API v2. Used by the avatar proxy on cache
 *  miss. Batched lookups (for the backfill script) use a different endpoint. */
async function fetchProfileImageUrl(
  handle: string,
  bearerToken: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(
      `${X_API_BASE}/users/by/username/${encodeURIComponent(handle)}?user.fields=profile_image_url`,
      {
        headers: { authorization: `Bearer ${bearerToken}` },
        signal: controller.signal,
      },
    );
    if (!r.ok) return null;
    const data = await r.json() as { data?: { profile_image_url?: string } };
    return data?.data?.profile_image_url ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function persistMissing(app: FastifyInstance, handle: string) {
  await app.pool.query(
    `INSERT INTO avatar_cache (handle, content_type, bytes, fetched_at)
       VALUES ($1, $2, '\\x', now())
       ON CONFLICT (handle) DO UPDATE
         SET content_type = EXCLUDED.content_type,
             bytes        = EXCLUDED.bytes,
             fetched_at   = EXCLUDED.fetched_at`,
    [handle, MISSING_CONTENT_TYPE],
  );
}

function sendImage(reply: any, contentType: string, bytes: Buffer) {
  reply.header('content-type', contentType);
  reply.header('cache-control', 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400');
  reply.header('etag', `"${crypto.createHash('sha1').update(bytes).digest('hex')}"`);
  return reply.send(bytes);
}

function sendMissing(reply: any) {
  // 404 lets the frontend's <img onerror> fire so it can render its own
  // letter-placeholder element. Short cache so failed handles recover
  // quickly without hammering us.
  reply.code(404);
  reply.header('cache-control', 'public, max-age=3600');
  reply.header('content-type', 'application/json');
  return reply.send({ error: 'AVATAR_MISSING' });
}
