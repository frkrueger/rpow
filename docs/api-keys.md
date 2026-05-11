# rpow2 API Keys

Long-lived bearer tokens for backend services that need to call the rpow2 API as an existing account.

Keys are issued manually by the rpow2 operator. There is no self-service endpoint and no admin UI yet. Lost or compromised keys → contact the operator to rotate.

## Auth header

Every request:
```
Authorization: Bearer rpow_sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

The token never expires. Issuing a new token for the same email immediately invalidates the previous one.

## Endpoints

Three endpoints accept API-key auth. All other endpoints require a session cookie and will reject Bearer tokens with 401.

### `GET /me`
Returns the account's balance, lifetime mint/send/receive totals, and daily mint cap usage.

```bash
curl -H "Authorization: Bearer $RPOW_KEY" https://api.rpow2.com/me
```

### `GET /activity?since=<iso8601>`
Polls activity (mints, sends, receives) since a cursor.

- **Without `since`:** returns the latest 100 entries DESC (existing behavior — bare array).
- **With `since`:** returns entries with `at > since`, ordered ASC, capped at 1000. Wrapped in an object with `next_cursor`.

```bash
# First call: no cursor known
curl -H "Authorization: Bearer $RPOW_KEY" \
  "https://api.rpow2.com/activity?since=2026-05-10T00:00:00Z"
# →  { "entries": [...], "next_cursor": "2026-05-10T18:42:11.123Z" }

# Subsequent polls: pass back the next_cursor
curl -H "Authorization: Bearer $RPOW_KEY" \
  "https://api.rpow2.com/activity?since=2026-05-10T18:42:11.123Z"
```

Store `next_cursor` between polls. If the response's `entries` is empty, `next_cursor` will be `null` — keep using your previous cursor.

### `POST /send`
Transfers RPOW. `idempotency_key` is required — sending the same key twice (e.g. on a transient network failure) returns the original transfer rather than double-spending.

```bash
curl -H "Authorization: Bearer $RPOW_KEY" -H "Content-Type: application/json" \
  -d '{"recipient_email":"alice@example.com","amount_base_units":"1000000000","idempotency_key":"swap-tx-12345"}' \
  https://api.rpow2.com/send
```

`amount_base_units` is in the smallest denomination (1 RPOW = 1,000,000,000 base units).

## Rate limits

`/send` only:
- **Burst:** 10 requests per second per key.
- **Hourly:** 1000 requests per hour per key.

Overflow: `429 Too Many Requests` with body `{ "error": "RATE_LIMITED", ... }`. The hourly cap response includes `retry_after: 3600`.

`/me` and `/activity` have no per-key cap.

## Errors

| Status | error | meaning |
|---|---|---|
| 401 | `UNAUTHORIZED` | Missing or invalid token. |
| 400 | `BAD_REQUEST` | Malformed body, bad `since` format, etc. |
| 400 | `INSUFFICIENT_BALANCE` | `/send` failed: not enough RPOW. |
| 429 | `RATE_LIMITED` | Burst or hourly cap on `/send` hit. |

## Key rotation

To rotate a key, the operator re-runs the issuance script. The previous key dies on the next request. Coordinate the swap with the operator beforehand to avoid downtime.
