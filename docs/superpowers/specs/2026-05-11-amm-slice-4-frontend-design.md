# AMM Slice 4 — Frontend (`/swap` + `/pool` + terms modal + banner)

**Date:** 2026-05-11
**Scope:** `apps/web` only — no server changes.
**Parent design:** `docs/superpowers/specs/2026-05-11-amm-design.md` Section 11.

## Problem

Slices 1–3 shipped the entire AMM backend: pool table, buy/sell, LP add/remove,
`/amm/me`, `/amm/accept-terms`, signed audit, all behind clean API endpoints.
The product can't be alpha-tested by humans because there is no web UI.

## Goal

Two new pages — `/swap` and `/pool` — that let a logged-in user with an
admin-credited USDC balance perform swaps and add/remove liquidity. Plus
a one-time terms-acceptance modal that gates writes, a persistent
funds-at-risk banner, and a "What is RPOW Pool?" footer info modal.

## Non-goals

- USDC deposit / withdrawal (slices 5 and 6).
- Recent-swaps marquee animation. A static list of the last 5 swaps is
  enough for v1.
- Mobile-first design. rpow's existing pages are desktop-monospace and
  AMM matches that.
- End-to-end browser tests. Component tests (vitest +
  @testing-library/react with mocked api / hooks / timers) cover the
  React behaviour, and slice-1–3 server tests cover the API.
- Dashboard / cards / color-coded buy-sell aesthetics. The AMM matches
  the rest of rpow: monospace, `Panel`, ASCII forms.

## Wallet integration

The existing `/wallet` page shows the user's RPOW balance via the
existing `useMe` hook. As part of this slice, `Wallet.tsx` is updated
to also display `me.usdc_base_units` immediately under the RPOW row:

```
BALANCE : 1,234.567890123 RPOW
USDC    : 500.00 USDC
```

`useMe`'s `MeResponse` already carries `usdc_base_units` (added in
slice 1). No new API call is needed. The display uses a simple USDC
formatter in `apps/web/src/lib/amm.ts` (6-decimal base units, two
fractional digits in display) — same module that hosts `minOut`.

If `usdc_base_units` is `'0'`, the row still renders (`0.00 USDC`) so
the wallet page consistently shows both balances regardless of state.

## Routes & navigation

Two top-level routes registered in `apps/web/src/App.tsx`:

- `/swap` → `<SwapPage />`
- `/pool` → `<PoolPage />`

Two new `NavLink`s added to the main nav, placed between `Wallet` and
`Mine` (concrete placement is mechanical; implementation may adjust).

Pages render inside the existing app shell (header / footer). The
funds-at-risk banner lives inside the page panels themselves — it does
NOT pollute `/wallet`, `/send`, `/ledger`, etc.

## Visual style

Match the existing terminal aesthetic exactly:
- `Panel` component for outer container.
- Monospace forms (`<input>` next to label, `[ BUTTON ]` style submit).
- ASCII success blocks (preformatted `<pre>` for confirmation output).
- The banner is a single yellow strip `⚠ GAME — funds at risk` rendered
  at the top of each AMM `Panel` body.

## Components & files

### New files

- `apps/web/src/pages/Swap.tsx` — swap form.
- `apps/web/src/pages/Pool.tsx` — pool stats + add/remove LP + recent swaps.
- `apps/web/src/components/AmmBanner.tsx` — the yellow `⚠ GAME — funds at
  risk` strip. Returns a single styled element; no logic. Reused on both
  pages.
- `apps/web/src/components/TermsModal.tsx` — terms-acceptance modal. The
  hook variant: exports a `useTermsGate()` hook that returns
  `{ ensureAccepted: () => Promise<boolean>, modal: ReactNode }`. The
  page calls `await ensureAccepted()` before any write; if `me.amm_terms_accepted_at`
  is null, the hook renders the modal and the promise resolves on
  user accept (`true`) or cancel (`false`). The page conditionally
  proceeds with the original action.
- `apps/web/src/components/WhatIsRpowPoolModal.tsx` — the "What is RPOW
  Pool?" footer info modal. Triggered by a footer link present on both
  AMM pages. Plain text explaining: it's a game, funds at risk, internal
  USDC, etc.
- `apps/web/src/hooks/useAmmPool.ts` — polls `GET /amm/pool` every 10 s
  while mounted. Returns `{ pool, refresh, loading, error }`.
- `apps/web/src/hooks/useAmmMe.ts` — fetches `GET /amm/me` on mount.
  Returns `{ ammMe, refresh, loading, error }`. Distinct from `useMe`;
  the existing `useMe` covers rpow wallet state, this covers AMM state
  (USDC balance, LP balance, terms timestamp).
- `apps/web/src/lib/amm.ts` — pure helpers. Exports:
  - `minOut(quoteOut: bigint, slippageBps: number): bigint` — computes
    `floor(quoteOut * (10000 - slippageBps) / 10000)`.
  - Any small formatters specific to AMM display (e.g., USDC formatter
    if it differs from RPOW).
- `apps/web/src/lib/amm.test.ts` — unit tests for `minOut` and other
  helpers.
- `apps/web/src/pages/Swap.test.tsx` — component tests.
- `apps/web/src/pages/Pool.test.tsx` — component tests.

### Modified files

- `apps/web/src/App.tsx` — register two routes + two NavLinks.
- `apps/web/src/api.ts` — add an `amm` namespace with methods listed
  below.

### API client surface

```ts
api.amm.pool()                  // GET /amm/pool
api.amm.me()                    // GET /amm/me
api.amm.quoteBuy(usdcIn)        // GET /amm/quote/buy?usdc_in=...
api.amm.quoteSell(rpowIn)       // GET /amm/quote/sell?rpow_in=...
api.amm.buy({usdc_in, min_rpow_out, idempotency_key})    // POST /amm/buy
api.amm.sell({rpow_in, min_usdc_out, idempotency_key})   // POST /amm/sell
api.amm.lpAdd({rpow_in, usdc_in, idempotency_key})       // POST /amm/lp/add
api.amm.lpRemove({lp_burn, min_rpow_out, min_usdc_out, idempotency_key})
                                                          // POST /amm/lp/remove
api.amm.acceptTerms()           // POST /amm/accept-terms
api.amm.swapsRecent()           // GET /amm/swaps/recent
```

Types reused from `@rpow/shared` where they exist (slice 1–3 already
defined them server-side).

## Page layouts

### `/swap`

Vertical, single-column, Send.tsx-style. Top to bottom:

```
⚠ GAME — funds at risk

SWAP
  DIRECTION : [ BUY RPOW ] [ SELL RPOW ]
  YOU PAY   : [____100___] USDC   (bal: 500.00)
  SLIPPAGE  : [_____0.5__] %
  YOU GET   : ~ 95.21 RPOW
  [ BUY ]

(error block, when applicable)
(success block, when applicable)

What is RPOW Pool?      pool: 5.4M RPOW / 2.6M USDC
```

Slippage is an inline field, not behind a gear icon.
The footer line shows current pool reserves + the info-modal link.

### `/pool`

Linear scroll, four `Panel`-nested sections, terminal aesthetic:

```
⚠ GAME — funds at risk

POOL
  reserves : 5,420,193.12 RPOW  /  2,608,401.50 USDC
  k        : 1.4143e13
  fee      : 0.30%
  price    : 1 RPOW = 0.481 USDC

  your LP  : 12,403.42 LP  (2.31% share)
  your RPOW share : 125,247 RPOW
  your USDC share : 60,254 USDC

ADD LIQUIDITY
  RPOW IN  : [_____1000_] RPOW  (bal 14,000)
  USDC IN  : [______481_] USDC  (auto-quoted; excess refunded)
  LP OUT   : ~ 481.50 LP
  [ ADD ]

REMOVE LIQUIDITY
  LP BURN  : [______500_] LP   (of 12,403.42)
  RPOW OUT : ~ 5,054 RPOW
  USDC OUT : ~ 2,432 USDC
  [ REMOVE ]

RECENT SWAPS
  14:02:11  BUY    100 USDC → 207.5 RPOW
  14:01:48  SELL   50 RPOW → 24.0 USDC
  ...

What is RPOW Pool?
```

## Data flow

### Pool polling

`useAmmPool` polls `GET /amm/pool` every 10 s while mounted. The
interval is cleared on unmount. Used by both `/swap` and `/pool`.

### Quote refresh

On every keystroke in the swap amount field, debounce 300 ms then call
`/amm/quote/buy` or `/amm/quote/sell`. Additionally re-fire the quote
whenever pool reserves change (the polled `useAmmPool` result changes
identity). Quote result lives in component local state and is
displayed in the `YOU GET` line.

The same logic applies to `/pool` for showing `LP OUT` (add) and
`RPOW OUT / USDC OUT` (remove) — the math is the pool-derived
expectations; the backend confirms exact values on submit.

### Slippage → min-out

User-facing input is a percent (default `0.5`). Component converts to
basis points (`50`) and uses the pure helper:

```ts
function minOut(quoteOut: bigint, slippageBps: number): bigint {
  return (quoteOut * BigInt(10000 - slippageBps)) / 10000n;
}
```

The result is what gets sent in `min_rpow_out` / `min_usdc_out` to the
server. For `/amm/lp/remove`, both `min_rpow_out` and `min_usdc_out`
are computed independently from the live quote.

Slippage bounds:
- Allowed range: `0.0` to `50.0` percent (0 to 5000 bps). Out-of-range
  values are rejected client-side with an inline error.

### Terms gate

On every write button click (BUY / SELL / ADD / REMOVE), the page calls
`await ensureAccepted()` from `useTermsGate()` BEFORE generating the
idempotency key or calling the API. If `amm_terms_accepted_at` is non-null
in `ammMe`, the function returns `true` immediately. Otherwise it shows
the modal:

- User clicks Accept → `api.amm.acceptTerms()` → `refresh()` on
  `useAmmMe` → resolve `true` → page proceeds with the original write.
- User clicks Cancel → resolve `false` → page does nothing further. No
  network call was made.

If `acceptTerms()` itself errors, the modal displays an inline error
and stays open. The write does not proceed.

### Refresh after writes

After any successful write (swap or LP op):
1. `useAmmPool.refresh()` — reserves changed.
2. `useAmmMe.refresh()` — balances and LP changed.
3. On `/pool` only: re-fetch `/amm/swaps/recent` so the new swap appears
   in the recent-swaps list (only relevant if `/swap` ever lands a user
   on `/pool`; in practice the `/swap` page does step 3 too so the
   `/pool` list stays consistent across navigations).

### Idempotency

Each write generates `crypto.randomUUID()` at the moment of submit
(matches the `/send` pattern in `Send.tsx:53`). The key is included in
the request body the server-side route already accepts.

## Error & empty states

### Pool not initialized

`GET /amm/pool` returns 404 or a payload with null reserves (whatever
slice-2 chose; the spec aligns with the actual contract). Pages render:

```
⚠ GAME — funds at risk

POOL
  not yet seeded.

ADD LIQUIDITY  (disabled)
REMOVE LIQUIDITY  (disabled)
```

For `/swap`: same — form disabled, message "pool not yet seeded".

### Not signed in

Same UX as `Send.tsx:75-80`:

```
SWAP / POOL
  not signed in.
  [ go to login ]
```

### Cold balances (slice 4 alpha)

Slice 5 / 6 (USDC deposit / withdrawal) hasn't shipped yet. A user with
zero USDC sees:

```
SWAP
  ...
  YOU PAY  : [____0____] USDC  (no USDC — ask an admin to credit you)
  [ BUY ]   ← disabled
```

A user with zero RPOW sees the analogous hint when in SELL direction.

### Insufficient balance

Pre-submit: input value > balance → button disabled, no quote call
(saves an API hop). Post-submit (race vs. another tab): server returns
`INSUFFICIENT_BALANCE` → inline error block under the form, same UX as
`Send.tsx:107`.

### Slippage exceeded

Server returns `SLIPPAGE_EXCEEDED` (or similar — confirm with slice-2's
error codes). Inline error block: "price moved against you, try again."

### LP-remove with zero LP

The LP BURN field is disabled with `(no LP)` hint.

### Quote in-flight

`YOU GET` shows `~ ...` while debouncing / awaiting. Submit button
disabled until the quote resolves.

### Recent swaps empty

If `/amm/swaps/recent` returns an empty array: section shows
`(no swaps yet)` rather than disappearing — preserves layout.

### Network error on any write

Generic inline error: "network error — try again". No cookie clearing
or auto-logout (this is the AMM, not auth).

## Testing

### Pure unit tests — `apps/web/src/lib/amm.test.ts`

```
minOut(0n, 50)                              → 0n
minOut(100n, 0)                             → 100n
minOut(100n, 50)                            → 99n   (0.5% slippage)
minOut(10_000n, 100)                        → 9900n (1% slippage)
minOut(10_000n, 5000)                       → 5000n (50% slippage)
minOut(very-large-bigint, 50)               → exact integer math
```

### Component tests — `Swap.test.tsx`

Same vi.mock + fake-timer pattern as the new `Send.test.tsx`. Mocked
modules: `../hooks/useMe.js`, `../hooks/useAmmPool.js`,
`../hooks/useAmmMe.js`, `../api.js`. MemoryRouter wrapper.

1. `quote_debounce` — type 4 characters with 100 ms gaps → exactly 1 quote
   API call fires 300 ms after the last keystroke
2. `terms_gate_on_first_buy` — click BUY, `amm_terms_accepted_at` is null
   → modal opens → Accept → `api.amm.acceptTerms` called → `api.amm.buy`
   called with the right `min_rpow_out`
3. `terms_skipped_when_accepted` — `amm_terms_accepted_at` is set → no
   modal → direct buy
4. `terms_cancel_aborts_write` — first BUY → modal → Cancel → no
   `acceptTerms` call, no `buy` call
5. `direction_toggle` — BUY then SELL fires the corresponding endpoints
6. `slippage_to_min_out` — slippage `1.0` + quote `100` → request body
   has `min_rpow_out: "99"`
7. `insufficient_balance_disables_submit`
8. `pool_not_initialized_disables_form`

### Component tests — `Pool.test.tsx`

1. `stats_render_from_pool_payload`
2. `add_lp_with_terms_gate` — analogous to swap test 2
3. `remove_lp_with_terms_gate`
4. `recent_swaps_renders` — non-empty array → list renders newest first
5. `recent_swaps_empty_state` — empty array → `(no swaps yet)`
6. `no_lp_disables_remove`

### What's out of scope for tests

- Server-side AMM behaviour (covered by slice-1/2/3 server tests).
- Real browser e2e (Playwright not run per-feature in this repo).
- Visual regression of the banner / modal styling.

## Files touched (summary)

New:
- `apps/web/src/pages/Swap.tsx`
- `apps/web/src/pages/Swap.test.tsx`
- `apps/web/src/pages/Pool.tsx`
- `apps/web/src/pages/Pool.test.tsx`
- `apps/web/src/components/AmmBanner.tsx`
- `apps/web/src/components/TermsModal.tsx`
- `apps/web/src/components/WhatIsRpowPoolModal.tsx`
- `apps/web/src/hooks/useAmmPool.ts`
- `apps/web/src/hooks/useAmmMe.ts`
- `apps/web/src/lib/amm.ts`
- `apps/web/src/lib/amm.test.ts`

Modified:
- `apps/web/src/App.tsx` — add `/swap` and `/pool` routes + NavLinks
- `apps/web/src/api.ts` — add `amm` namespace
- `apps/web/src/pages/Wallet.tsx` — render `me.usdc_base_units` row under
  the existing RPOW balance row

## Open questions

None at design time. Implementation plan will resolve API request /
response shape details from the slice 1–3 server code.
