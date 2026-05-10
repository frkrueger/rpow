# API Keys for Programmatic Access — Design

**Date:** 2026-05-10
**Branch:** `feat/api-keys`
**First user:** `rpow2swap@protonmail.com` (operator of a swap service)

## Goal

Let trusted operators authenticate to a small subset of `rpow2` endpoints with a long-lived bearer token, instead of a session cookie. The token authenticates **as an existing user account** — same balance, same activity log, same `/send` semantics.

The first concrete use case: keep `rpow2swap@protonmail.com` "logged in" from a backend service so it can poll for incoming RPOW transfers and send RPOW out to its swap users programmatically.

## Non-goals

- No admin frontend for issuing/revoking keys (manual via CLI script).
- No scoped keys (read-only, write-only, etc.) — keys grant access to the full hardcoded subset.
- No webhooks — operator polls `/activity?since=` for incoming detection.
- No multi-key per account, no expiry, no rotation API. Re-running the issuance script replaces the existing key.

## Design decisions

| Decision | Choice |
|---|---|
| Endpoint scope | Hardcoded subset: `/me`, `/send`, `/activity`. All other routes ignore the `Authorization` header. |
| Incoming-transfer detection | Polling `/activity?since=<iso8601>` (new query param). |
| Keys per account | One. Issuing again replaces the previous key. Never expires. |
| Token format | `Authorization: Bearer rpow_sk_<32 random bytes base64url>` (~51 chars total). |
| Rate limits | Per-key: 10/sec and 1000/hour on `/send`. Sessions unrestricted (status quo). |
| Issuance | CLI script: `node dist/scripts/issue-api-key.js --email <email>`. |

## Architecture

### Storage — `api_keys` table

```sql
CREATE TABLE api_keys (
  email          TEXT        PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
  token_hash     BYTEA       NOT NULL,
  token_prefix   TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX api_keys_token_hash_idx ON api_keys(token_hash);
```

- `token_hash`: `sha256(plaintext)`. Plaintext is never stored.
- `token_prefix`: first 12 characters of the plaintext (`rpow_sk_xxxx`). Used to identify which key is which when looking at the DB. Not sensitive.
- `last_used_at`: updated fire-and-forget on each successful API-key auth. Used for "is this key still in use?" diagnostics; not load-bearing for security.

### Auth resolver

New function in `apps/server/src/routes/auth.ts` (or a new `auth-resolver.ts` if the file gets crowded). It both **returns** the resolved identity and **attaches** flags to the request so the rate-limit hook can read them:

```ts
declare module 'fastify' {
  interface FastifyRequest {
    viaApiKey?: boolean;
    apiKeyHash?: string;  // hex-encoded sha256, used as the rate-limit bucket key
  }
}

export async function readAuth(
  req: FastifyRequest,
  app: FastifyInstance,
): Promise<{ email: string; viaApiKey: boolean } | null> {
  // 1. Try API-key path: Authorization: Bearer rpow_sk_*
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer rpow_sk_')) {
    const plaintext = auth.slice('Bearer '.length);
    const hashBuf = sha256(plaintext);
    const { rows } = await app.pool.query<{ email: string }>(
      'SELECT email FROM api_keys WHERE token_hash = $1',
      [hashBuf],
    );
    if (rows[0]) {
      // Fire-and-forget last_used_at update
      app.pool.query('UPDATE api_keys SET last_used_at = now() WHERE token_hash = $1', [hashBuf])
        .catch(err => app.log.warn({ err }, 'api_keys last_used_at update failed'));
      req.viaApiKey = true;
      req.apiKeyHash = hashBuf.toString('hex');
      return { email: rows[0].email, viaApiKey: true };
    }
    // Bearer token present but no match → fall through to session, NOT 401.
    // (A user could have a stale key + a valid cookie; cookie still works.)
  }

  // 2. Fall through to session cookie
  const s = readSession(req as any, app.config.sessionSecret);
  if (s) {
    req.viaApiKey = false;
    return { email: s.email, viaApiKey: false };
  }

  return null;
}
```

**Hook ordering for rate limit:** `@fastify/rate-limit` runs in `onRequest` by default, which fires *before* `preHandler` — meaning `req.viaApiKey` won't be set yet. Two viable fixes:
1. Configure the rate-limit plugin's `hook` option to `'preHandler'` and ensure `readAuth()` is called in an earlier `preHandler`.
2. Compute the hash inside `keyGenerator` directly from the header (re-parse the Bearer token), bypassing `req.viaApiKey`. The `skip` callback also re-parses.

Option 1 is cleaner; option 2 is the fallback if the plugin's hook can't be moved. Choose at implementation time after a quick check of the plugin docs.

**Route adoption — only three sites change:**
- `apps/server/src/routes/me.ts` — `readSession()` → `readAuth()`
- `apps/server/src/routes/send.ts` — `readSession()` → `readAuth()`
- `apps/server/src/routes/activity.ts` — `readSession()` → `readAuth()`

All other routes (`/longshot/*`, `/srpow/*`, `/claim`, `/auth/*`, `/challenge`, `/mint`, etc.) keep `readSession()` and therefore reject API keys implicitly. **The hardcoded subset is enforced at the auth-call sites, not via a path allowlist.** This makes adding/removing endpoints from the subset a one-line, locally-reasonable change.

### `/activity?since=` filter

**Backwards-compatible additive change.**

- **Without `since`** (existing callers): unchanged. Returns the bare array of latest entries DESC.
- **With `since=<iso8601>`**: returns a wrapped object:
  ```json
  {
    "entries": [...],   // entries with at > since, ordered ASC, capped at 1000
    "next_cursor": "2026-05-10T19:32:01.234567Z"  // or null if entries empty
  }
  ```
- Operator stores `next_cursor` and passes it as `since` on the next call.
- Edge case: two entries with identical `at` (microsecond collision is rare) — the second one would be skipped because we filter `at > since`. Acceptable for v1 given timestamp resolution and per-account send velocity.

### Rate limiting

Uses `@fastify/rate-limit` (already a dependency).

Per-route on `/send`, **only when `req.viaApiKey === true`**:

```ts
app.post('/send', {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: '1 second',
      keyGenerator: (req: any) => req.apiKeyHash ?? req.ip,
      skip: (req: any) => !req.viaApiKey,
    }
  }
}, ...)
```

Stack a second rate-limit registration for the 1000/hr cap, keyed identically.

`req.apiKeyHash` and `req.viaApiKey` are set by `readAuth()` — the handler attaches them to the request before any rate-limit hook fires. (If Fastify's hook ordering doesn't allow this — e.g., `preHandler` runs after `onRequest` rate-limit — we move the rate-limit to a `preHandler` after auth, or read the header directly inside `keyGenerator` to compute the hash.)

**Response on cap hit:** `429 Too Many Requests` with `Retry-After` header. Body: `{ "error": "RATE_LIMITED", "retry_after": <seconds> }`.

Sessions remain unrestricted (status quo).

### Issuance script

`apps/server/scripts/issue-api-key.ts`:

```
Usage: node dist/scripts/issue-api-key.js --email <email>

Generates a fresh API key for <email>, replacing any existing key.
Prints the plaintext token ONCE to stdout — capture it now, it cannot be recovered.
```

Steps:
1. Parse `--email`. Validate email format.
2. Open `pg.Pool` with `DATABASE_URL` from env.
3. Verify `email` exists in `users` — fail with clear error if not.
4. Generate `crypto.randomBytes(32).toString('base64url')` → `suffix`.
5. `plaintext = 'rpow_sk_' + suffix`
6. `hash = sha256(plaintext)`, `prefix = plaintext.slice(0, 12)`.
7. `INSERT INTO api_keys(email, token_hash, token_prefix) VALUES($1, $2, $3) ON CONFLICT (email) DO UPDATE SET token_hash = EXCLUDED.token_hash, token_prefix = EXCLUDED.token_prefix, created_at = now(), last_used_at = NULL`.
8. Print:
   ```
   API key issued for <email>
   token (store securely — won't be shown again):

       rpow_sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

   prefix in DB: rpow_sk_xxxx
   ```
9. Close pool, exit 0.

**Operator command (run from laptop):**
```bash
ssh ubuntu@15.204.254.192 \
  'sudo -u rpow node /opt/rpow/repo/apps/server/dist/scripts/issue-api-key.js --email rpow2swap@protonmail.com'
```

### Operator docs (`docs/api-keys.md`)

A short, three-section page the operator reads once:

**1. Auth header**
```
Authorization: Bearer rpow_sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**2. Three endpoints, with curl examples**
```bash
# balance + account info
curl -H "Authorization: Bearer $RPOW_KEY" https://api.rpow2.com/me

# poll incoming activity (ASC, capped 1000); store next_cursor for next call
curl -H "Authorization: Bearer $RPOW_KEY" \
  "https://api.rpow2.com/activity?since=2026-05-10T00:00:00Z"

# send tokens (idempotency_key required — same key safely retries on transient failures)
curl -H "Authorization: Bearer $RPOW_KEY" -H "Content-Type: application/json" \
  -d '{"recipient_email":"alice@example.com","amount_base_units":"1000000000","idempotency_key":"swap-tx-12345"}' \
  https://api.rpow2.com/send
```

**3. Limits + errors**
- `/send`: 10 req/sec and 1000 req/hour per key. `429` with `Retry-After` on overflow.
- `/me`, `/activity`: no per-key cap.
- `401 UNAUTHORIZED`: bad or missing token.
- `400 BAD_REQUEST` / `409 INSUFFICIENT_BALANCE` on `/send`: standard send errors.
- Lost or compromised key → operator contacts us to rerun the issuance script. The old key dies immediately on replacement.

## Security considerations

- **Storage:** plaintext token never persists server-side. `token_hash` is a sha256 — adequate because tokens are 32 bytes of CSPRNG entropy (no need for a slow hash like bcrypt; brute force is infeasible).
- **Transport:** Bearer tokens travel over HTTPS only. nginx terminates TLS at api.rpow2.com.
- **Logging:** the auth header must be redacted from request logs. Verify Fastify's default logger doesn't log headers (it doesn't, but worth a grep through any custom log middleware).
- **Replacement on rotation:** issuing a new key for an email replaces the row atomically. The old key stops working on the next request. No grace period — operator must coordinate the swap.
- **Stale-key fallback:** if a Bearer token is sent but doesn't match, `readAuth()` falls through to checking the session cookie rather than 401-ing. Reasoning: a logged-in user with a stale key in their browser shouldn't be locked out. The cost is one extra DB lookup on each request; acceptable.

## Out of scope for v1

The following are deliberately deferred:

- Multiple keys per account (with labels).
- Key expiry / rotation policy.
- Scoped keys (read-only, write-only, sub-resource).
- Webhooks for incoming transfers.
- Self-service key management (web UI or `/api/keys` endpoint).
- Per-key rate-limit overrides in DB.
- Audit log of API-key actions beyond `last_used_at`.

These can be layered on without breaking the v1 contract.

## Files to create / modify

**New:**
- `apps/server/migrations/014_api_keys.sql` — table + index.
- `apps/server/scripts/issue-api-key.ts` — issuance CLI.
- `docs/api-keys.md` — operator-facing docs.

**Modified:**
- `apps/server/src/routes/auth.ts` — add `readAuth()`. Keep `readSession()` exported.
- `apps/server/src/routes/me.ts` — switch to `readAuth()`.
- `apps/server/src/routes/send.ts` — switch to `readAuth()`, attach rate-limit config.
- `apps/server/src/routes/activity.ts` — switch to `readAuth()`, add `since` query handling and dual response shape.
- `packages/shared/src/protocol.ts` — keep `ActivityResponse = ActivityEntry[]` unchanged. Add a sibling type `ActivityResponseSince = { entries: ActivityEntry[]; next_cursor: string | null }`. The route returns one or the other based on the presence of `?since=`. This avoids touching existing web-client consumers.

## Verification

- Unit: hash + verify roundtrip; `readAuth()` returns correct `viaApiKey` flag for each path.
- Integration: issue a key via the script, hit `/me` with Bearer header, confirm 200; hit `/longshot/spin` with Bearer header, confirm 401.
- Manual: rate-limit smoke test with `seq 20 | xargs -P 20 -I {} curl ...` against `/send`, expect ~10 successes and the rest 429.
- Manual: re-run issuance for the same email, confirm the old token returns 401 and the new one works.
