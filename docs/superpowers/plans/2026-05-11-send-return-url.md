# Send return_url Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `/send?return_url=…` bounce the user (and a postMessage signal) back to an allowlisted partner site after a successful send.

**Architecture:** A pure helper resolves+validates `return_url` against a hardcoded origin allowlist. `Send.tsx` reads the param on mount, stores the validated `URL | null` in state, and runs a `useEffect` on `status === 'sent'` that postMessages the opener, navigates the opener (or current tab as fallback), then closes after a 600 ms dwell.

**Tech Stack:** React 18, react-router-dom 6, Vitest 1, jsdom. No server changes.

**Spec:** `docs/superpowers/specs/2026-05-11-send-return-url-design.md`

---

## File Structure

- **Create** `apps/web/src/lib/returnUrl.ts` — exports `ALLOWED_RETURN_ORIGINS` constant and `resolveReturnTarget(raw, allowlist)` pure function. Pure logic, easily unit-tested.
- **Create** `apps/web/src/lib/returnUrl.test.ts` — vitest unit tests for the helper. First unit test in `apps/web/src`; that's fine, vitest is already configured.
- **Modify** `apps/web/src/pages/Send.tsx` — read `return_url` on mount, store validated target in state, add bounce `useEffect`, swap the success/pending block for a "returning…" line when bouncing.

The helper file isolates the only logic worth unit-testing. The React bits get manual verification via `npm run dev` — see Task 4.

---

## Task 1: Pure return-url helper + unit tests

**Files:**
- Create: `apps/web/src/lib/returnUrl.ts`
- Create: `apps/web/src/lib/returnUrl.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `apps/web/src/lib/returnUrl.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveReturnTarget } from './returnUrl.js';

const allow = ['https://halstavern.net', 'http://localhost:5173'];

describe('resolveReturnTarget', () => {
  it('returns URL when origin is in the allowlist', () => {
    const u = resolveReturnTarget('https://halstavern.net/games/xyz?a=1', allow);
    expect(u).not.toBeNull();
    expect(u!.origin).toBe('https://halstavern.net');
    expect(u!.pathname).toBe('/games/xyz');
    expect(u!.searchParams.get('a')).toBe('1');
  });

  it('returns URL for the dev origin', () => {
    const u = resolveReturnTarget('http://localhost:5173/x', allow);
    expect(u?.origin).toBe('http://localhost:5173');
  });

  it('returns null when origin is not allowlisted', () => {
    expect(resolveReturnTarget('https://evil.example.com/x', allow)).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(resolveReturnTarget('not a url', allow)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(resolveReturnTarget('', allow)).toBeNull();
  });

  it('returns null for null input', () => {
    expect(resolveReturnTarget(null, allow)).toBeNull();
  });

  it('rejects allowlist near-misses (different scheme)', () => {
    // halstavern.net is allowed on https only; http should be rejected.
    expect(resolveReturnTarget('http://halstavern.net/x', allow)).toBeNull();
  });

  it('rejects allowlist near-misses (subdomain)', () => {
    expect(resolveReturnTarget('https://evil.halstavern.net/x', allow)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/returnUrl.test.ts`

Expected: FAIL with a module-resolution error like "Failed to resolve import './returnUrl.js'" or "Cannot find module".

- [ ] **Step 3: Implement the helper**

Create `apps/web/src/lib/returnUrl.ts`:

```ts
export const ALLOWED_RETURN_ORIGINS: readonly string[] = [
  'https://halstavern.net',
  'http://localhost:5173',
];

/**
 * Parse `raw` as a URL and return it only if its origin is in `allowlist`.
 * Returns null for malformed input, missing input, or disallowed origins.
 * The allowlist is matched on full origin (scheme + host + port) — no
 * subdomain wildcards, no scheme upgrades.
 */
export function resolveReturnTarget(
  raw: string | null | undefined,
  allowlist: readonly string[],
): URL | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  return allowlist.includes(u.origin) ? u : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/returnUrl.test.ts`

Expected: PASS — 8 tests passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/returnUrl.ts apps/web/src/lib/returnUrl.test.ts
git commit -m "feat(send): pure return-url validator + unit tests"
```

---

## Task 2: Wire `return_url` into Send.tsx state on mount

**Files:**
- Modify: `apps/web/src/pages/Send.tsx` (top of file + existing mount effect at lines 24-33)

- [ ] **Step 1: Add the import**

In `apps/web/src/pages/Send.tsx`, add this import alongside the existing imports near the top of the file:

```ts
import { ALLOWED_RETURN_ORIGINS, resolveReturnTarget } from '../lib/returnUrl.js';
```

- [ ] **Step 2: Add the new state**

Right after the existing `useState` declarations (after `const [sentAmt, setSentAmt] = useState('');` on `Send.tsx:20`), add:

```ts
const [returnTarget, setReturnTarget] = useState<URL | null>(null);
```

- [ ] **Step 3: Extend the existing mount effect to read return_url**

The current effect (`Send.tsx:24-33`) reads `to`, `amount`, `memo`. Extend it to also read `return_url`. The full updated effect should read:

```ts
  // URL prefill — supports `https://rpow2.com/#/send?to=email&amount=N&memo=abc&return_url=…`
  // (and the equivalent /wallet link, which redirects here). Read once on mount.
  useEffect(() => {
    const to = searchParams.get('to');
    const amt = searchParams.get('amount');
    const m = searchParams.get('memo');
    if (to) setRecipient(to);
    if (amt) setAmount(amt);
    if (m) setMemo(m);
    setReturnTarget(resolveReturnTarget(searchParams.get('return_url'), ALLOWED_RETURN_ORIGINS));
    // intentionally not depending on searchParams — prefill only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 4: Type-check**

Run: `cd apps/web && npx tsc -b --noEmit`

Expected: clean exit, no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Send.tsx
git commit -m "feat(send): read return_url query param on mount"
```

---

## Task 3: Bounce effect + render swap

**Files:**
- Modify: `apps/web/src/pages/Send.tsx` (effect after the mount effect; render block currently at lines 92-106)

- [ ] **Step 1: Add the bounce effect**

Immediately after the mount-prefill effect (after the closing `}, []);` from Task 2 step 3), insert this new effect:

```ts
  // Post-success bounce: if a validated return_url is set and the send
  // succeeded (completed or pending), signal the opener and navigate back.
  useEffect(() => {
    if (status !== 'sent' || !returnTarget) return;

    const payload = {
      type: 'rpow:send_complete',
      transfer_id: transferId,
      pending,
      at: new Date().toISOString(),
    };

    let openerNav = false;
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, returnTarget.origin);
        window.opener.location.href = returnTarget.toString();
        window.opener.focus?.();
        openerNav = true;
      }
    } catch {
      // sealed/exotic opener — fall through to current-tab navigation
    }

    const timer = setTimeout(() => {
      if (openerNav) window.close();
      else window.location.href = returnTarget.toString();
    }, 600);
    return () => clearTimeout(timer);
  }, [status, returnTarget, transferId, pending]);
```

- [ ] **Step 2: Swap the success/pending render block for a returning-indicator when bouncing**

Replace the existing render block at `Send.tsx:92-106`:

```tsx
      {status === 'sent' && !pending && (
        <pre style={{ margin: '12px 0 0' }}>
{`  + SENT  ${sentAmt} RPOW → ${sentTo}${memo ? `\n  memo: ${memo}` : ''}
  transfer id: ${transferId}`}
        </pre>
      )}
      {status === 'sent' && pending && (
        <pre style={{ margin: '12px 0 0' }}>
{`  + PENDING CLAIM
  ${sentTo} does not have an rpow2 account yet.
  An email has been sent inviting them to claim ${sentAmt} RPOW.
  Your tokens are reserved until they claim or the link expires (30d).
  transfer id: ${transferId}`}
        </pre>
      )}
```

with:

```tsx
      {status === 'sent' && returnTarget && (
        <pre style={{ margin: '12px 0 0' }}>
{`  ↩ returning to ${returnTarget.hostname}…`}
        </pre>
      )}
      {status === 'sent' && !returnTarget && !pending && (
        <pre style={{ margin: '12px 0 0' }}>
{`  + SENT  ${sentAmt} RPOW → ${sentTo}${memo ? `\n  memo: ${memo}` : ''}
  transfer id: ${transferId}`}
        </pre>
      )}
      {status === 'sent' && !returnTarget && pending && (
        <pre style={{ margin: '12px 0 0' }}>
{`  + PENDING CLAIM
  ${sentTo} does not have an rpow2 account yet.
  An email has been sent inviting them to claim ${sentAmt} RPOW.
  Your tokens are reserved until they claim or the link expires (30d).
  transfer id: ${transferId}`}
        </pre>
      )}
```

- [ ] **Step 3: Type-check**

Run: `cd apps/web && npx tsc -b --noEmit`

Expected: clean exit, no errors.

- [ ] **Step 4: Run the existing unit test to make sure nothing regressed**

Run: `cd apps/web && npx vitest run`

Expected: PASS — the returnUrl tests still pass; no other tests exist yet.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Send.tsx
git commit -m "feat(send): bounce to return_url after successful send"
```

---

## Task 4: Manual verification

**Files:** none modified. This task is verification only.

The React component changes can't be reliably unit-tested without heavy
window.opener/window.close mocking in jsdom. Verify by running the dev
server and walking through each scenario from the spec's test plan.

- [ ] **Step 1: Start the dev stack**

In one terminal:
```bash
cd apps/web && npm run dev
```

In another terminal, start the server side (so `/send` API works):
```bash
cd apps/server && npm run dev
```

Confirm `apps/web` is serving at `http://localhost:5173`.

- [ ] **Step 2: Sign in as a test user with a positive balance**

Open `http://localhost:5173/#/login`, complete the email flow. Confirm `/wallet` shows non-zero RPOW.

- [ ] **Step 3: Verify scenario A — popup with valid return_url, completed send**

Open a JS console on `http://localhost:5173/` (any rpow page) and run:
```js
window.open('http://localhost:5173/#/send?to=<another-test-account>&amount=0.1&return_url=http%3A%2F%2Flocalhost%3A5173%2F%23%2Fwallet', '_blank');
```

In the popup: submit the form. Expected:
- Success block briefly shows `↩ returning to localhost…`
- Within ~1 s the popup closes
- The opener tab navigates to `/#/wallet`

- [ ] **Step 4: Verify scenario B — popup with valid return_url, pending claim**

Same as Step 3 but use a recipient email that has NO rpow account (e.g. `nobody-${Date.now()}@example.com`).

Expected: identical bounce behavior. Payload sent to opener has `pending: true` (verify via `window.addEventListener('message', e => console.log(e.data))` on the opener before opening the popup).

- [ ] **Step 5: Verify scenario C — fresh tab (no opener) with valid return_url**

Paste this URL directly in a fresh browser tab (don't `window.open`):
`http://localhost:5173/#/send?to=<test-account>&amount=0.1&return_url=http%3A%2F%2Flocalhost%3A5173%2F%23%2Fwallet`

Submit the form. Expected:
- `↩ returning to localhost…` flashes
- This tab navigates to `/#/wallet` (no close, since no opener to defer to)

- [ ] **Step 6: Verify scenario D — disallowed origin**

Open: `http://localhost:5173/#/send?to=<test-account>&amount=0.1&return_url=https%3A%2F%2Fevil.example.com%2Fx`

Submit. Expected:
- Page behaves exactly as today: full SENT block, no bounce, no navigation.

- [ ] **Step 7: Verify scenario E — malformed return_url**

Open: `http://localhost:5173/#/send?to=<test-account>&amount=0.1&return_url=not%20a%20url`

Submit. Expected: same as Scenario D — no bounce, no errors in console.

- [ ] **Step 8: Verify scenario F — failed send stays on rpow**

Open `/#/send` with no return_url. Set amount higher than your balance. Submit.
Expected: error message renders normally; no bounce-related behavior.

Then open `/#/send?return_url=http%3A%2F%2Flocalhost%3A5173%2F%23%2Fwallet`. Set amount higher than balance. Submit.
Expected: error message renders normally; no bounce (because `status === 'error'`, not `'sent'`).

- [ ] **Step 9: Document any deviations**

If any scenario fails, do NOT proceed to merge. Open an issue/note and either fix the implementation or update the spec. If all scenarios pass, this task is complete — no commit (verification only).

---

## Self-review notes

- **Spec coverage:**
  - Hardcoded allowlist → Task 1 (`ALLOWED_RETURN_ORIGINS`).
  - Read `return_url` on mount → Task 2.
  - `useEffect` watching `status === 'sent'` covering both completed and pending → Task 3 Step 1.
  - postMessage payload with `transfer_id`, `pending`, `at` → Task 3 Step 1.
  - Opener path: postMessage → opener.location → focus → close self after 600 ms → Task 3 Step 1.
  - No-opener fallback: navigate this tab → Task 3 Step 1 (`openerNav === false` branch).
  - "Returning to <hostname>…" render replacement → Task 3 Step 2.
  - Page unchanged when `returnTarget === null` → Task 3 Step 2 (the two `!returnTarget` branches mirror the original render).
  - Error path unchanged → Task 4 Step 8.
  - All 6 spec manual scenarios → Task 4 Steps 3-8.
- **Placeholder scan:** none.
- **Type consistency:** `resolveReturnTarget`, `ALLOWED_RETURN_ORIGINS`, and `returnTarget: URL | null` are used consistently across Tasks 1-3.
