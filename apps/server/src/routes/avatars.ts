import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';

const UPSTREAM_BASE = 'https://unavatar.io/twitter/';
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
        await persistMissing(app, handle);
        return sendMissing(reply);
      }
      const contentType = upstream.headers.get('content-type') ?? 'image/jpeg';
      const bytes = Buffer.from(await upstream.arrayBuffer());
      // unavatar.io sometimes serves a generic placeholder PNG for handles
      // it can't resolve. Anything under 1KB is almost certainly that
      // placeholder, not a real avatar. Treat it as a miss so we don't
      // pollute the cache with grey squares.
      if (bytes.length < 1024) {
        await persistMissing(app, handle);
        return sendMissing(reply);
      }

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
    } finally {
      clearTimeout(timer);
    }
  });
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
