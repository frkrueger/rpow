import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';

const UPSTREAM_BASE = 'https://unavatar.io/twitter/';
const FETCH_TIMEOUT_MS = 5_000;
// X / Twitter handle rules: 1-15 chars, [A-Za-z0-9_]. Anything else is rejected
// to keep the URL space tight and prevent path-traversal-style abuse.
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

// 1x1 transparent PNG used as the fallback when the handle is invalid or
// the upstream fetch fails. Short cache so we retry soon.
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** Server-side X-avatar proxy with persistent Postgres cache.
 *
 *  GET /api/avatars/x/:handle
 *
 *  Lookup order:
 *    1. avatar_cache table — if a row exists, serve the cached bytes.
 *    2. unavatar.io/twitter/{handle} — fetch upstream, store, serve.
 *    3. Fallback to a 1x1 transparent PNG on any error.
 *
 *  Once a handle is cached, we never call upstream for it again (the row
 *  has no TTL). A future admin route can force-refresh by deleting the row.
 *
 *  Response headers: long Cache-Control + ETag so CDN/browser caches do
 *  the bulk of the work — the DB only fields the cold misses. */
export async function avatarRoutes(app: FastifyInstance) {
  app.get<{ Params: { handle: string } }>('/api/avatars/x/:handle', async (req, reply) => {
    const { handle } = req.params;

    if (!HANDLE_RE.test(handle)) {
      return sendFallback(reply);
    }

    // 1. Cache lookup.
    const cached = await app.pool.query<{ content_type: string; bytes: Buffer }>(
      'SELECT content_type, bytes FROM avatar_cache WHERE handle = $1',
      [handle],
    );
    if (cached.rows.length > 0) {
      const row = cached.rows[0]!;
      return sendImage(reply, row.content_type, row.bytes);
    }

    // 2. Upstream fetch.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const upstream = await fetch(`${UPSTREAM_BASE}${handle}`, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 (rpow-avatar-proxy)',
          accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8',
        },
      });
      if (!upstream.ok) {
        return sendFallback(reply);
      }
      const contentType = upstream.headers.get('content-type') ?? 'image/jpeg';
      const bytes = Buffer.from(await upstream.arrayBuffer());

      // Store. ON CONFLICT no-op handles the race where two requests for
      // the same cold handle land at once.
      await app.pool.query(
        `INSERT INTO avatar_cache (handle, content_type, bytes, fetched_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (handle) DO NOTHING`,
        [handle, contentType, bytes],
      );

      return sendImage(reply, contentType, bytes);
    } catch {
      return sendFallback(reply);
    } finally {
      clearTimeout(timer);
    }
  });
}

function sendImage(reply: any, contentType: string, bytes: Buffer) {
  reply.header('content-type', contentType);
  reply.header('cache-control', 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400');
  reply.header('etag', `"${crypto.createHash('sha1').update(bytes).digest('hex')}"`);
  return reply.send(bytes);
}

function sendFallback(reply: any) {
  reply.header('content-type', 'image/png');
  // Short cache so a bad fetch can recover quickly. CDN will still absorb bursts.
  reply.header('cache-control', 'public, max-age=300');
  return reply.send(TRANSPARENT_PNG);
}
