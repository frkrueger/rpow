# Send page return_url + post-success bounce

**Date:** 2026-05-11
**Scope:** `apps/web/src/pages/Send.tsx` only — no server changes.

## Problem

External partners (currently halstavern.net) link users to rpow's `/send`
page with the recipient/amount/memo pre-filled. After a successful send the
user stays on the rpow success page and has to manually navigate back to the
partner site. This is a dead-end UX: the partner game/app has no way to know
the payment completed, and the user has to context-switch.

## Goal

Let a partner pass a `return_url` query param to `/send`. After a successful
send, signal the opener (if any) and navigate back to that URL, then close
the rpow tab. Fall back to navigating the current tab when there is no
usable opener.

## Non-goals

- Server-side knowledge of `return_url`. The query param is purely a
  client-side concern; `POST /send` is unchanged.
- Telemetry beyond the existing `gtag('send_tokens', …)` event.
- Bouncing on a failed send. Errors keep the user on rpow.
- iframe / embedded mode. rpow is not designed to render inside a frame.
- Distinguishing completed vs pending sends in the bounce behavior. Both
  bounce identically — from the partner's perspective the payment is
  committed in both cases.

## Trigger sources & inputs

`Send.tsx` already reads `to`, `amount`, `memo` from the URL on mount
(`Send.tsx:24-33`). Partners append one new param:

```
https://rpow2.com/#/send?to=alice@example.com&amount=5&memo=halstavern&return_url=https%3A%2F%2Fhalstavern.net%2Fgames%2Fxyz
```

The send form behavior is unchanged when `return_url` is missing or invalid.

## Allowlist

Hardcoded constant at the top of `Send.tsx`:

```ts
const ALLOWED_RETURN_ORIGINS = [
  'https://halstavern.net',
  'http://localhost:5173',
];
```

Rationale: list is tiny, requires a deploy to add partners regardless of
whether it lives in code or env, and keeping it in code makes it reviewable
in git. Origins outside the allowlist are silently ignored (treated as
"no return_url provided") — no error UI, the page just behaves as today.

This is the phishing boundary. The risk being mitigated: a malicious site
links to `/send?return_url=https://evil.com` and uses a fake post-send page
to phish the rpow user. Allowlist prevents that.

## State & lifecycle

One new piece of component state:

```ts
const [returnTarget, setReturnTarget] = useState<URL | null>(null);
```

Set on mount alongside the existing prefill effect:

```ts
const raw = searchParams.get('return_url');
if (raw) {
  try {
    const u = new URL(raw);
    if (ALLOWED_RETURN_ORIGINS.includes(u.origin)) setReturnTarget(u);
  } catch { /* ignore malformed */ }
}
```

## Bounce effect

A new `useEffect` watches `status` and `returnTarget`. Fires exactly once
when `status === 'sent'` (covers both completed and pending) AND
`returnTarget` is non-null:

```
1. Compose the postMessage payload:
     { type: 'rpow:send_complete',
       transfer_id,
       pending,            // boolean — partner can render differently if it cares
       at: new Date().toISOString() }

2. If window.opener exists and is not closed:
     - opener.postMessage(payload, returnTarget.origin)
     - opener.location.href = returnTarget.toString()
     - opener.focus?.()
     - setTimeout(() => window.close(), 600)

3. Else (no opener / sealed):
     - setTimeout(() => { window.location.href = returnTarget.toString() }, 600)
```

All opener access is wrapped in a single try/catch (the only opener
operation that can throw cross-origin is none of these — postMessage and
location-write are both allowed cross-origin — but defensive try/catch
keeps a sealed/exotic opener from crashing the page).

The 600 ms dwell is intentional: it lets the user briefly see that the send
succeeded before the bounce. No countdown or cancel control.

## Render changes

When `returnTarget !== null && status === 'sent'`, render a one-line
"returning to <hostname>…" block in place of the existing multi-line
success/pending blocks:

```
↩ returning to halstavern.net…
```

This keeps the UI honest about what's about to happen during the 600 ms
window, instead of flashing the full success summary then suddenly
navigating away. The partner is responsible for rendering its own receipt
using the postMessage payload (or its own server-side state).

When `returnTarget === null`, the page renders exactly as today: full
success or pending block, no bounce.

## Files touched

- `apps/web/src/pages/Send.tsx` — the only file modified.

## Test plan

- **Unit / integration**: none server-side; this is a client-only UI change.
- **Manual verification**:
  1. `/send?to=…&amount=1&return_url=http://localhost:5173/test` opened via
     `window.open` from `localhost:5173`. After successful send: opener
     navigates, this tab closes within ~1s.
  2. Same URL pasted directly in a fresh tab (no opener). After successful
     send: this tab navigates to `localhost:5173/test`.
  3. `return_url=https://attacker.example.com` — invalid origin. Page
     behaves exactly as today; no bounce.
  4. `return_url=not%20a%20url` — malformed. Page behaves exactly as today.
  5. Send fails (e.g., insufficient balance). Stays on rpow with error.
  6. PENDING claim (recipient has no account). Bounces identically to
     completed; payload includes `pending: true`.

## Open questions

None at design time. Implementation plan will resolve any further details.
