# AMM Slice 4 Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/swap` and `/pool` web pages, a terms-acceptance modal, a funds-at-risk banner, an info modal, and a USDC balance row on `/wallet` — all backed by existing slice-1/2/3 AMM endpoints.

**Architecture:** Pure helpers in `lib/amm.ts`; thin polling/fetch hooks `useAmmPool` and `useAmmMe`; shared `AmmBanner`, `TermsModal` (with promise-gate `useTermsGate` hook), `WhatIsRpowPoolModal`; two page components `Swap.tsx` and `Pool.tsx` styled to match the existing terminal/`Panel` aesthetic; minimal modifications to `Wallet.tsx`, `api.ts`, and `App.tsx`.

**Tech Stack:** React 18, react-router-dom 6, Vitest 1 + jsdom + @testing-library/react. No server changes.

**Spec:** `docs/superpowers/specs/2026-05-11-amm-slice-4-frontend-design.md`

**Important spec correction (verified against slice 1–3 server code):** the spec describes API write bodies as including `idempotency_key`, but the actual Zod schemas in `apps/server/src/routes/amm/{swap.ts,lp.ts}` do NOT accept that field. Real request shapes:
- `POST /amm/buy` — `{ usdc_base_units: string, min_rpow_out: string }`
- `POST /amm/sell` — `{ rpow_base_units: string, min_usdc_out: string }`
- `POST /amm/lp/add` — `{ rpow_base_units: string, usdc_base_units: string, min_lp_out: string }`
- `POST /amm/lp/remove` — `{ lp_base_units: string, min_rpow_out: string, min_usdc_out: string }`
- `POST /amm/accept-terms` — `{}` (empty body)

The plan uses these real shapes. Also note `/amm/me` returns `terms_accepted_at` (not `amm_terms_accepted_at` — the latter is the column name exposed by `/me`).

**Important: AMM allowlist.** All `/amm/*` endpoints require the user's email to be in the server's `ammAllowedEmails` allowlist. Otherwise they return `403 NOT_ALLOWED`. The frontend treats this like an empty state: render "AMM access not enabled for your account" instead of the form.

---

## File Structure

**New:**
- `apps/web/src/lib/amm.ts` — pure helpers: `minOut(quoteOut, slippageBps)`, `formatUsdc(baseUnits)`, `parseUsdcToBaseUnits(decimal)`, `parsePercentToBps(decimal)`
- `apps/web/src/lib/amm.test.ts` — unit tests for the four pure helpers
- `apps/web/src/hooks/useAmmPool.ts` — polls `GET /amm/pool` every 10s; exposes `{ pool, refresh, loading, error }`
- `apps/web/src/hooks/useAmmMe.ts` — fetches `GET /amm/me` on mount; exposes `{ ammMe, refresh, loading, error }`
- `apps/web/src/components/AmmBanner.tsx` — single styled element
- `apps/web/src/components/WhatIsRpowPoolModal.tsx` — info modal
- `apps/web/src/components/TermsModal.tsx` — terms modal + `useTermsGate` hook
- `apps/web/src/pages/Swap.tsx` — swap form
- `apps/web/src/pages/Swap.test.tsx` — component tests
- `apps/web/src/pages/Pool.tsx` — pool stats + add/remove LP + recent swaps
- `apps/web/src/pages/Pool.test.tsx` — component tests

**Modified:**
- `apps/web/src/api.ts` — add `amm` namespace with 10 methods
- `apps/web/src/pages/Wallet.tsx` — add a USDC `stat-cell` to the WALLET panel
- `apps/web/src/App.tsx` — register `/swap` + `/pool` routes and two `NavLink`s

---

## Task 1: Pure helpers in `lib/amm.ts` + unit tests

**Files:**
- Create: `apps/web/src/lib/amm.ts`
- Create: `apps/web/src/lib/amm.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `apps/web/src/lib/amm.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { minOut, formatUsdc, parseUsdcToBaseUnits, parsePercentToBps } from './amm.js';

describe('minOut', () => {
  it('returns 0 when quoteOut is 0', () => {
    expect(minOut(0n, 50)).toBe(0n);
  });
  it('returns quoteOut when slippage is 0', () => {
    expect(minOut(100n, 0)).toBe(100n);
  });
  it('subtracts 0.5% slippage (50 bps) on 100', () => {
    expect(minOut(100n, 50)).toBe(99n);
  });
  it('subtracts 1% (100 bps) on 10000', () => {
    expect(minOut(10000n, 100)).toBe(9900n);
  });
  it('floors toward zero on integer division', () => {
    // 10001 * 9950 / 10000 = 9950.995 → 9950
    expect(minOut(10001n, 50)).toBe(9950n);
  });
  it('handles large bigints without overflow', () => {
    const big = 1_000_000_000_000_000_000n;
    expect(minOut(big, 50)).toBe(995_000_000_000_000_000n);
  });
  it('returns 0n when slippage is 10000 bps (100%)', () => {
    expect(minOut(100n, 10000)).toBe(0n);
  });
});

describe('formatUsdc', () => {
  it('formats 0 as 0.00', () => {
    expect(formatUsdc('0')).toBe('0.00');
  });
  it('formats 1_000_000 as 1.00 (USDC = 6 decimals)', () => {
    expect(formatUsdc('1000000')).toBe('1.00');
  });
  it('formats 1_234_567_890 as 1234.57 (rounded down)', () => {
    expect(formatUsdc('1234567890')).toBe('1234.57');
  });
  it('formats 500_000 as 0.50', () => {
    expect(formatUsdc('500000')).toBe('0.50');
  });
  it('includes thousand separators for readability', () => {
    expect(formatUsdc('1234567890000')).toBe('1,234,567.89');
  });
});

describe('parseUsdcToBaseUnits', () => {
  it('parses "1" as "1000000"', () => {
    expect(parseUsdcToBaseUnits('1')).toBe('1000000');
  });
  it('parses "0.50" as "500000"', () => {
    expect(parseUsdcToBaseUnits('0.50')).toBe('500000');
  });
  it('parses "1.234567" as "1234567" (6 decimal max)', () => {
    expect(parseUsdcToBaseUnits('1.234567')).toBe('1234567');
  });
  it('throws on more than 6 decimal places', () => {
    expect(() => parseUsdcToBaseUnits('1.1234567')).toThrow();
  });
  it('throws on non-numeric', () => {
    expect(() => parseUsdcToBaseUnits('abc')).toThrow();
  });
  it('throws on negative', () => {
    expect(() => parseUsdcToBaseUnits('-1')).toThrow();
  });
});

describe('parsePercentToBps', () => {
  it('parses "0.5" as 50 bps', () => {
    expect(parsePercentToBps('0.5')).toBe(50);
  });
  it('parses "1" as 100 bps', () => {
    expect(parsePercentToBps('1')).toBe(100);
  });
  it('parses "0" as 0 bps', () => {
    expect(parsePercentToBps('0')).toBe(0);
  });
  it('parses "50" as 5000 bps (max allowed)', () => {
    expect(parsePercentToBps('50')).toBe(5000);
  });
  it('throws on > 50 percent', () => {
    expect(() => parsePercentToBps('51')).toThrow();
  });
  it('throws on negative', () => {
    expect(() => parsePercentToBps('-0.5')).toThrow();
  });
  it('throws on non-numeric', () => {
    expect(() => parsePercentToBps('abc')).toThrow();
  });
});
```

- [ ] **Step 2: Run the test file and confirm it fails**

Run: `cd apps/web && npx vitest run src/lib/amm.test.ts`

Expected: FAIL with module resolution error ("Failed to resolve import './amm.js'").

- [ ] **Step 3: Implement the helpers**

Create `apps/web/src/lib/amm.ts`:

```ts
/**
 * Compute the min-out amount given a quote and a slippage in basis points.
 * Pure integer math: `floor(quoteOut * (10000 - slippageBps) / 10000)`.
 * Used to populate `min_rpow_out` / `min_usdc_out` / `min_lp_out` in AMM
 * write requests so the server rejects slippage drift.
 */
export function minOut(quoteOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 10000) {
    throw new Error(`slippageBps out of range: ${slippageBps}`);
  }
  return (quoteOut * BigInt(10000 - slippageBps)) / 10000n;
}

const USDC_DECIMALS = 6;
const USDC_DIVISOR = 1_000_000n;

/**
 * Format USDC base units (6-decimal) as a human-readable string with
 * thousand separators and 2 fractional digits. Rounds toward zero —
 * never overstate balances.
 */
export function formatUsdc(baseUnits: string): string {
  const n = BigInt(baseUnits);
  const whole = n / USDC_DIVISOR;
  // Two fractional digits → keep 2 of the 6 decimals, dropping the rest.
  const fraction = (n % USDC_DIVISOR) / 10_000n; // 6 decimals → 2 decimals
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fracStr = fraction.toString().padStart(2, '0');
  return `${wholeStr}.${fracStr}`;
}

/**
 * Parse a decimal USDC string (e.g. "1.50") into base units (e.g. "1500000").
 * Throws on bad input: more than 6 decimal places, non-numeric, negative.
 */
export function parseUsdcToBaseUnits(s: string): string {
  if (!/^\d+(\.\d{1,6})?$/.test(s)) {
    throw new Error(`invalid USDC amount: ${s}`);
  }
  const [whole, frac = ''] = s.split('.');
  const padded = (frac + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  const combined = BigInt(whole) * USDC_DIVISOR + BigInt(padded || '0');
  return combined.toString();
}

/**
 * Parse a percent string (e.g. "0.5") to basis points (e.g. 50). Validates
 * range [0, 50] percent (= [0, 5000] bps). Throws on bad input.
 */
export function parsePercentToBps(s: string): number {
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`invalid percent: ${s}`);
  }
  const percent = Number(s);
  if (!Number.isFinite(percent) || percent < 0 || percent > 50) {
    throw new Error(`percent out of range [0, 50]: ${s}`);
  }
  return Math.round(percent * 100);
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `cd apps/web && npx vitest run src/lib/amm.test.ts`

Expected: PASS — 25+ tests passing (7 minOut + 5 formatUsdc + 6 parseUsdc + 7 parsePercent).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/amm.ts apps/web/src/lib/amm.test.ts
git commit -m "feat(amm): pure helpers (minOut, formatUsdc, parsers) + unit tests"
```

---

## Task 2: `api.ts` AMM namespace

**Files:**
- Modify: `apps/web/src/api.ts`

- [ ] **Step 1: Read the existing api.ts to confirm the `call<T>` helper shape and existing pattern**

Run: `cat apps/web/src/api.ts`

Expected: see `call<T>(method, path, body?)` helper and `api = { authRequest, me, send, ... }` object.

- [ ] **Step 2: Add a typed AMM API surface**

Modify `apps/web/src/api.ts` — add types and the `amm` namespace to the existing `api` export. The full replacement of the file:

```ts
import type {
  AuthRequestBody, AuthRequestResponse, MeResponse,
  ChallengeResponse, MintRequestBody, MintResponse,
  SendRequestBody, SendResponse, ActivityResponse, LedgerResponse, ApiError,
  PhantomChallengeResponse, PhantomBindResponse, WrapResponse, WrapEvent,
} from '@rpow/shared';

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method, credentials: 'include',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let err: ApiError;
    try { err = await res.json(); } catch { err = { error: 'INTERNAL', message: res.statusText }; }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// --- AMM types (local to this file; not yet in @rpow/shared) -----------------

export type AmmPoolResponse =
  | { seeded: false }
  | {
      seeded: true;
      reserves: { rpow_base_units: string; usdc_base_units: string };
      total_lp_supply: string;
      fee_bps: number;
      spot_price_usdc_per_rpow_e9: string;
      seeded_at: string;
      your_lp_balance?: string;
    };

export type AmmMeResponse = {
  email: string;
  usdc_base_units: string;
  lp_balance: string;
  terms_accepted_at: string | null;
  spot_price_usdc_per_rpow_e9: string | null;
  your_pool_share_bps: string | null;
};

export type AmmQuoteBuyResponse = {
  rpow_out: string;
  fee_base_units: string;
  price_impact_bps: string;
  spot_price_usdc_per_rpow_e9: string;
};

export type AmmQuoteSellResponse = {
  usdc_out: string;
  fee_base_units: string;
  price_impact_bps: string;
  spot_price_usdc_per_rpow_e9: string;
};

export type AmmSwapResult = {
  swap_id: string;
  output_base_units: string;
  fee_base_units: string;
  pool_rpow_after: string;
  pool_usdc_after: string;
  signature_hex: string;
  server_time: string;
};

export type AmmLpAddResult = {
  event_id: string;
  lp_minted: string;
  rpow_consumed: string;
  usdc_consumed: string;
  signature_hex: string;
  server_time: string;
};

export type AmmLpRemoveResult = {
  event_id: string;
  rpow_received: string;
  usdc_received: string;
  signature_hex: string;
  server_time: string;
};

export type AmmRecentSwap = {
  id: string;
  x_handle: string | null;
  direction: 'BUY' | 'SELL';
  rpow_delta_base_units: string;
  usdc_delta_base_units: string;
  fee_base_units: string;
  pool_rpow_after: string;
  pool_usdc_after: string;
  created_at: string;
};

export type AmmSwapsRecentResponse = { swaps: AmmRecentSwap[] };

export type AmmAcceptTermsResponse = { accepted_at: string };

// --- API surface -------------------------------------------------------------

export const api = {
  authRequest: (b: AuthRequestBody) => call<AuthRequestResponse>('POST', '/auth/request', b),
  me: () => call<MeResponse>('GET', '/me'),
  logout: () => call<{ ok: true }>('POST', '/auth/logout'),
  challenge: () => call<ChallengeResponse>('POST', '/challenge'),
  mint: (b: MintRequestBody) => call<MintResponse>('POST', '/mint', b),
  send: (b: SendRequestBody) => call<SendResponse>('POST', '/send', b),
  activity: () => call<ActivityResponse>('GET', '/activity'),
  ledger: () => call<LedgerResponse>('GET', '/ledger'),
  phantomChallenge: () => call<PhantomChallengeResponse>('POST', '/phantom/challenge'),
  phantomBind: (b: { nonce: string; wallet_address: string; signature_base58: string }) =>
    call<PhantomBindResponse>('POST', '/phantom/bind', b),
  srpowWrap: (b: { amount_base_units: string; idempotency_key: string }) =>
    call<WrapResponse>('POST', '/srpow/wrap', b),
  srpowEvents: () => call<WrapEvent[]>('GET', '/srpow/events'),
  amm: {
    pool: () => call<AmmPoolResponse>('GET', '/amm/pool'),
    me: () => call<AmmMeResponse>('GET', '/amm/me'),
    quoteBuy: (usdc_base_units: string) =>
      call<AmmQuoteBuyResponse>('GET', `/amm/quote/buy?usdc_base_units=${encodeURIComponent(usdc_base_units)}`),
    quoteSell: (rpow_base_units: string) =>
      call<AmmQuoteSellResponse>('GET', `/amm/quote/sell?rpow_base_units=${encodeURIComponent(rpow_base_units)}`),
    buy: (b: { usdc_base_units: string; min_rpow_out: string }) =>
      call<AmmSwapResult>('POST', '/amm/buy', b),
    sell: (b: { rpow_base_units: string; min_usdc_out: string }) =>
      call<AmmSwapResult>('POST', '/amm/sell', b),
    lpAdd: (b: { rpow_base_units: string; usdc_base_units: string; min_lp_out: string }) =>
      call<AmmLpAddResult>('POST', '/amm/lp/add', b),
    lpRemove: (b: { lp_base_units: string; min_rpow_out: string; min_usdc_out: string }) =>
      call<AmmLpRemoveResult>('POST', '/amm/lp/remove', b),
    acceptTerms: () => call<AmmAcceptTermsResponse>('POST', '/amm/accept-terms', {}),
    swapsRecent: () => call<AmmSwapsRecentResponse>('GET', '/amm/swaps/recent'),
  },
};
```

- [ ] **Step 3: Type-check**

Run: `cd apps/web && npx tsc -b`

Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/api.ts
git commit -m "feat(amm): typed api.amm namespace covering all slice-1-3 endpoints"
```

---

## Task 3: Hooks `useAmmPool` and `useAmmMe`

**Files:**
- Create: `apps/web/src/hooks/useAmmPool.ts`
- Create: `apps/web/src/hooks/useAmmMe.ts`

- [ ] **Step 1: Implement `useAmmPool`**

Create `apps/web/src/hooks/useAmmPool.ts`:

```ts
import { useEffect, useState, useCallback, useRef } from 'react';
import { api, type AmmPoolResponse } from '../api.js';

const POLL_INTERVAL_MS = 10_000;

/**
 * Polls `GET /amm/pool` every 10s while mounted. Returns the latest pool
 * snapshot, a manual `refresh()`, and loading/error state.
 *
 * Errors are surfaced so callers can render a degraded state instead of
 * a blank page. `pool` is `null` only on the initial fetch.
 */
export function useAmmPool(): {
  pool: AmmPoolResponse | null;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
} {
  const [pool, setPool] = useState<AmmPoolResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const p = await api.amm.pool();
      if (mounted.current) {
        setPool(p);
        setError(null);
      }
    } catch (err) {
      if (mounted.current) setError(err);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  return { pool, loading, error, refresh };
}
```

- [ ] **Step 2: Implement `useAmmMe`**

Create `apps/web/src/hooks/useAmmMe.ts`:

```ts
import { useEffect, useState, useCallback, useRef } from 'react';
import { api, type AmmMeResponse } from '../api.js';

/**
 * Fetches `GET /amm/me` once on mount and on demand via `refresh()`. Used
 * by AMM pages for USDC balance, LP balance, and terms acceptance status.
 *
 * Errors are surfaced (e.g. 401 unauthorized, 403 NOT_ALLOWED when the
 * user isn't on the AMM allowlist) so callers can render the right empty
 * state.
 */
export function useAmmMe(): {
  ammMe: AmmMeResponse | null;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
} {
  const [ammMe, setAmmMe] = useState<AmmMeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const m = await api.amm.me();
      if (mounted.current) {
        setAmmMe(m);
        setError(null);
      }
    } catch (err) {
      if (mounted.current) setError(err);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  return { ammMe, loading, error, refresh };
}
```

- [ ] **Step 3: Type-check**

Run: `cd apps/web && npx tsc -b`

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/hooks/useAmmPool.ts apps/web/src/hooks/useAmmMe.ts
git commit -m "feat(amm): useAmmPool (10s poll) and useAmmMe hooks"
```

---

## Task 4: `AmmBanner` + `WhatIsRpowPoolModal` components

**Files:**
- Create: `apps/web/src/components/AmmBanner.tsx`
- Create: `apps/web/src/components/WhatIsRpowPoolModal.tsx`

- [ ] **Step 1: Implement `AmmBanner`**

Create `apps/web/src/components/AmmBanner.tsx`:

```tsx
/**
 * Persistent funds-at-risk strip rendered at the top of every AMM page.
 * Yellow on dark; one line of text. No interaction.
 */
export function AmmBanner() {
  return (
    <div
      role="note"
      style={{
        background: 'rgba(255, 224, 102, 0.08)',
        color: '#ffe066',
        border: '1px solid #6a5a00',
        padding: '4px 8px',
        marginBottom: 10,
        fontSize: 12,
      }}
    >
      ⚠ GAME — funds at risk
    </div>
  );
}
```

- [ ] **Step 2: Implement `WhatIsRpowPoolModal`**

Create `apps/web/src/components/WhatIsRpowPoolModal.tsx`:

```tsx
import { useState } from 'react';

/**
 * Footer link "What is RPOW Pool?" → modal explaining it's a game,
 * how the pool works at a high level, and that USDC is internal-only
 * (no Solana withdrawal yet in slice 4). Plain text; no state beyond
 * open/closed.
 */
export function WhatIsRpowPoolModal() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <a
        href="#"
        onClick={(e) => { e.preventDefault(); setOpen(true); }}
        style={{ color: '#888', fontSize: 11 }}
      >
        What is RPOW Pool?
      </a>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.7)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#111', color: '#e6e6e6',
              border: '1px solid #444', padding: 18,
              maxWidth: 520, fontSize: 13, lineHeight: 1.6,
              fontFamily: 'ui-monospace, Menlo, monospace',
            }}
          >
            <div style={{ fontWeight: 'bold', marginBottom: 8 }}>What is RPOW Pool?</div>
            <p style={{ margin: '0 0 8px' }}>
              RPOW Pool is an experimental on-platform automated market maker
              (AMM) where you can swap between RPOW tokens and internal USDC.
              Liquidity providers (LPs) earn a share of the 0.30% swap fee.
            </p>
            <p style={{ margin: '0 0 8px' }}>
              This is a <strong>game</strong>. Balances are internal accounting
              entries within rpow2; the USDC here is not currently bridged to
              Solana. Funds can be lost to slippage, smart play by other users,
              or bugs we haven't found yet.
            </p>
            <p style={{ margin: '0 0 12px' }}>
              The pool uses constant-product math (x · y = k) similar to
              Uniswap V2. The price changes with every swap proportionally to
              the trade size.
            </p>
            <button onClick={() => setOpen(false)}>[ close ]</button>
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `cd apps/web && npx tsc -b`

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/AmmBanner.tsx apps/web/src/components/WhatIsRpowPoolModal.tsx
git commit -m "feat(amm): AmmBanner + WhatIsRpowPoolModal components"
```

---

## Task 5: `TermsModal` + `useTermsGate` hook

**Files:**
- Create: `apps/web/src/components/TermsModal.tsx`

- [ ] **Step 1: Implement the modal + gate hook**

Create `apps/web/src/components/TermsModal.tsx`:

```tsx
import { useState, useCallback, type ReactNode } from 'react';
import { api } from '../api.js';

/**
 * Promise-gate for AMM writes. Usage:
 *
 *   const { ensureAccepted, modal } = useTermsGate(termsAcceptedAt, onAccepted);
 *   // render `{modal}` somewhere in your component tree
 *   async function submit() {
 *     if (!(await ensureAccepted())) return;
 *     await api.amm.buy(...);
 *   }
 *
 * If `termsAcceptedAt` is already set, `ensureAccepted()` resolves `true`
 * immediately without rendering the modal. Otherwise the modal opens; the
 * promise resolves `true` when the user accepts (and `/amm/accept-terms`
 * succeeds), or `false` when they cancel or the accept call fails.
 */
export function useTermsGate(
  termsAcceptedAt: string | null,
  onAccepted: () => Promise<void> | void,
): { ensureAccepted: () => Promise<boolean>; modal: ReactNode } {
  const [state, setState] = useState<
    | { kind: 'closed' }
    | { kind: 'open'; resolve: (v: boolean) => void; submitting: boolean; error: string | null }
  >({ kind: 'closed' });

  const ensureAccepted = useCallback((): Promise<boolean> => {
    if (termsAcceptedAt) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      setState({ kind: 'open', resolve, submitting: false, error: null });
    });
  }, [termsAcceptedAt]);

  async function accept() {
    if (state.kind !== 'open') return;
    setState({ ...state, submitting: true, error: null });
    try {
      await api.amm.acceptTerms();
      await onAccepted();
      const { resolve } = state;
      setState({ kind: 'closed' });
      resolve(true);
    } catch (err: any) {
      setState({
        ...state,
        submitting: false,
        error: err?.message ?? err?.error ?? 'failed to accept terms',
      });
    }
  }

  function cancel() {
    if (state.kind !== 'open') return;
    const { resolve } = state;
    setState({ kind: 'closed' });
    resolve(false);
  }

  const modal =
    state.kind === 'open' ? (
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000,
        }}
      >
        <div
          style={{
            background: '#111', color: '#e6e6e6',
            border: '1px solid #444', padding: 18,
            maxWidth: 520, fontSize: 13, lineHeight: 1.6,
            fontFamily: 'ui-monospace, Menlo, monospace',
          }}
        >
          <div style={{ fontWeight: 'bold', marginBottom: 8 }}>
            ⚠ Accept AMM terms
          </div>
          <p style={{ margin: '0 0 8px' }}>
            RPOW Pool is an experimental game. By using it you understand:
          </p>
          <ul style={{ margin: '0 0 12px 20px', padding: 0 }}>
            <li>Funds are at risk. You can lose to slippage, other users, or bugs.</li>
            <li>USDC balances are internal — not currently withdrawable to Solana.</li>
            <li>The 0.30% swap fee accrues to liquidity providers.</li>
          </ul>
          {state.error && (
            <div style={{ color: '#ff6666', marginBottom: 8 }}>error: {state.error}</div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={accept} disabled={state.submitting}>
              [ {state.submitting ? '...' : 'ACCEPT'} ]
            </button>
            <button onClick={cancel} disabled={state.submitting}>
              [ CANCEL ]
            </button>
          </div>
        </div>
      </div>
    ) : null;

  return { ensureAccepted, modal };
}
```

- [ ] **Step 2: Type-check**

Run: `cd apps/web && npx tsc -b`

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/TermsModal.tsx
git commit -m "feat(amm): TermsModal + useTermsGate promise-based gate hook"
```

---

## Task 6: `Wallet.tsx` — add USDC row

**Files:**
- Modify: `apps/web/src/pages/Wallet.tsx`

- [ ] **Step 1: Read the current Wallet stat-grid section**

Run: `grep -n 'stat-cell' apps/web/src/pages/Wallet.tsx`

Expected: see lines like `<div className="stat-cell">` for MINTED, RECEIVED, SENT, DAILY REMAINING.

- [ ] **Step 2: Add a USDC stat-cell**

Modify `apps/web/src/pages/Wallet.tsx`. Add an import for the USDC formatter:

```tsx
import { formatUsdc } from '../lib/amm.js';
```

Then insert a new `stat-cell` immediately after the existing `BALANCE` cell — the current code is:

```tsx
          <div className="stat-cell full">
            <div className="stat-label">BALANCE</div>
            <div className="stat-value highlight">{formatRpow(me.balance_base_units)} RPOW</div>
          </div>
```

Add right after it (still inside `<div className="stat-grid">`):

```tsx
          <div className="stat-cell full">
            <div className="stat-label">USDC</div>
            <div className="stat-value">{formatUsdc(me.usdc_base_units)} USDC</div>
          </div>
```

- [ ] **Step 3: Type-check**

Run: `cd apps/web && npx tsc -b`

Expected: exit 0. The `MeResponse` type already has `usdc_base_units: string` (added in slice 1).

- [ ] **Step 4: Run all existing tests to make sure Wallet isn't broken**

Run: `cd apps/web && npx vitest run`

Expected: all previous tests pass (returnUrl, Send, amm helpers from Task 1).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Wallet.tsx
git commit -m "feat(wallet): show USDC balance under RPOW"
```

---

## Task 7: `Swap.tsx` page + component tests

**Files:**
- Create: `apps/web/src/pages/Swap.tsx`
- Create: `apps/web/src/pages/Swap.test.tsx`

- [ ] **Step 1: Implement `Swap.tsx`**

Create `apps/web/src/pages/Swap.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { AmmBanner } from '../components/AmmBanner.js';
import { WhatIsRpowPoolModal } from '../components/WhatIsRpowPoolModal.js';
import { useTermsGate } from '../components/TermsModal.js';
import { useMe } from '../hooks/useMe.js';
import { useAmmPool } from '../hooks/useAmmPool.js';
import { useAmmMe } from '../hooks/useAmmMe.js';
import { api } from '../api.js';
import { formatRpow, parseRpowToBaseUnits } from '../lib/format.js';
import {
  minOut, formatUsdc, parseUsdcToBaseUnits, parsePercentToBps,
} from '../lib/amm.js';

const DEBOUNCE_MS = 300;

type Direction = 'BUY' | 'SELL';

export function SwapPage() {
  const { me } = useMe();
  const { pool, refresh: refreshPool } = useAmmPool();
  const { ammMe, refresh: refreshAmm } = useAmmMe();

  const [direction, setDirection] = useState<Direction>('BUY');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState('0.5');
  const [quoteOut, setQuoteOut] = useState<bigint | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ output: string; fee: string } | null>(null);

  const { ensureAccepted, modal } = useTermsGate(
    ammMe?.terms_accepted_at ?? null,
    refreshAmm,
  );

  // Debounced quote refresh on amount change + pool change.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQuoteOut(null);
    if (!amount || !pool || (pool as any).seeded === false) return;
    setQuoteLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        if (direction === 'BUY') {
          const usdcBase = parseUsdcToBaseUnits(amount);
          const q = await api.amm.quoteBuy(usdcBase);
          setQuoteOut(BigInt(q.rpow_out));
        } else {
          const rpowBase = parseRpowToBaseUnits(amount);
          const q = await api.amm.quoteSell(rpowBase);
          setQuoteOut(BigInt(q.usdc_out));
        }
      } catch {
        setQuoteOut(null);
      } finally {
        setQuoteLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [amount, direction, pool]);

  const ammDisallowed = (ammMe === null && !!error) || ((ammMe as any)?.error === 'NOT_ALLOWED');
  const seeded = pool && (pool as any).seeded === true;
  const usdcBalDisplay = ammMe ? formatUsdc(ammMe.usdc_base_units) : '0.00';
  const rpowBalDisplay = me ? formatRpow(me.balance_base_units) : '0';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!seeded || !quoteOut) return;
    setStatus('sending'); setError(''); setResult(null);
    try {
      const slippageBps = parsePercentToBps(slippage);
      const minOutValue = minOut(quoteOut, slippageBps);
      if (!(await ensureAccepted())) {
        setStatus('idle');
        return;
      }
      if (direction === 'BUY') {
        const r = await api.amm.buy({
          usdc_base_units: parseUsdcToBaseUnits(amount),
          min_rpow_out: minOutValue.toString(),
        });
        setStatus('sent');
        setResult({ output: r.output_base_units, fee: r.fee_base_units });
      } else {
        const r = await api.amm.sell({
          rpow_base_units: parseRpowToBaseUnits(amount),
          min_usdc_out: minOutValue.toString(),
        });
        setStatus('sent');
        setResult({ output: r.output_base_units, fee: r.fee_base_units });
      }
      await Promise.all([refreshPool(), refreshAmm()]);
    } catch (err: any) {
      setStatus('error');
      const code = err?.error ?? 'INTERNAL';
      const msgs: Record<string, string> = {
        INSUFFICIENT_BALANCE: 'insufficient balance',
        SLIPPAGE_EXCEEDED: 'price moved against you, try again',
        POOL_NOT_SEEDED: 'pool not yet seeded',
        NOT_ALLOWED: 'AMM access not enabled for your account',
        TERMS_NOT_ACCEPTED: 'terms not accepted',
        BAD_REQUEST: err?.message ?? 'bad request',
      };
      setError(msgs[code] ?? code);
    }
  }

  if (!me) return (
    <Panel title="SWAP">
      <AmmBanner />
      <div>not signed in.</div>
      <div style={{ marginTop: 8 }}><Link to="/login">[ go to login ]</Link></div>
    </Panel>
  );

  if (ammDisallowed) return (
    <Panel title="SWAP">
      <AmmBanner />
      <div>AMM access not enabled for your account.</div>
    </Panel>
  );

  if (pool && (pool as any).seeded === false) return (
    <Panel title="SWAP">
      <AmmBanner />
      <pre style={{ margin: 0 }}>{`  pool not yet seeded.`}</pre>
      <div style={{ marginTop: 12, color: '#888', fontSize: 11 }}>
        <WhatIsRpowPoolModal />
      </div>
    </Panel>
  );

  const balForDirection = direction === 'BUY' ? `${usdcBalDisplay} USDC` : `${rpowBalDisplay} RPOW`;
  const amountUnit = direction === 'BUY' ? 'USDC' : 'RPOW';
  const outUnit = direction === 'BUY' ? 'RPOW' : 'USDC';
  const outDisplay =
    quoteLoading ? '...' :
    quoteOut === null ? '—' :
    direction === 'BUY' ? formatRpow(quoteOut.toString()) : formatUsdc(quoteOut.toString());

  return (
    <Panel title="SWAP">
      <AmmBanner />
      <form onSubmit={submit}>
        <div style={{ marginBottom: 6 }}>
          DIRECTION : {' '}
          <button type="button" onClick={() => setDirection('BUY')} disabled={direction === 'BUY'}>[ BUY RPOW ]</button>
          {' '}
          <button type="button" onClick={() => setDirection('SELL')} disabled={direction === 'SELL'}>[ SELL RPOW ]</button>
        </div>
        <div>YOU PAY   : <input
          type="text" inputMode="decimal" required
          value={amount} onChange={(e) => setAmount(e.target.value)}
          style={{ width: '14ch' }} aria-label="amount in"
        /> {amountUnit} <span style={{ color: '#888' }}>(bal: {balForDirection})</span></div>
        <div style={{ marginTop: 4 }}>SLIPPAGE  : <input
          type="text" inputMode="decimal" required
          value={slippage} onChange={(e) => setSlippage(e.target.value)}
          style={{ width: '6ch' }} aria-label="slippage percent"
        /> %</div>
        <div style={{ marginTop: 6 }}>YOU GET   : ~ {outDisplay} {outUnit}</div>
        <div style={{ marginTop: 8 }}>
          <button type="submit" disabled={status === 'sending' || !quoteOut}>
            [ {status === 'sending' ? '...' : direction} ]
          </button>
        </div>
      </form>
      {status === 'sent' && result && (
        <pre style={{ margin: '12px 0 0' }}>
{`  + ${direction} ${amount} ${amountUnit} → ${direction === 'BUY' ? formatRpow(result.output) + ' RPOW' : formatUsdc(result.output) + ' USDC'}
  fee: ${direction === 'BUY' ? formatUsdc(result.fee) + ' USDC' : formatRpow(result.fee) + ' RPOW'}`}
        </pre>
      )}
      {status === 'error' && <div className="error" style={{ marginTop: 8 }}>error: {error}</div>}
      <div style={{ marginTop: 12, color: '#888', fontSize: 11 }}>
        <WhatIsRpowPoolModal />
        {pool && (pool as any).seeded && (
          <span style={{ marginLeft: 12 }}>
            pool: {formatRpow((pool as any).reserves.rpow_base_units)} RPOW / {formatUsdc((pool as any).reserves.usdc_base_units)} USDC
          </span>
        )}
      </div>
      {modal}
    </Panel>
  );
}
```

- [ ] **Step 2: Write component tests**

Create `apps/web/src/pages/Swap.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SwapPage } from './Swap.js';

vi.mock('../hooks/useMe.js', () => ({
  useMe: () => ({
    me: {
      email: 'me@test.com',
      balance_base_units: '1000000000000',
      minted_base_units: '0',
      sent_base_units: '0',
      received_base_units: '0',
      wrap_allowed: false,
      solana_wallet: null,
      x_handle: null,
      x_avatar_url: null,
      srpow_supply_owned_base_units: '0',
      daily_mint_cap_base_units: '0',
      daily_minted_base_units: '0',
      daily_remaining_base_units: '0',
      usdc_base_units: '500000000',
      amm_terms_accepted_at: null,
    },
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

const poolMock = {
  pool: {
    seeded: true,
    reserves: { rpow_base_units: '5000000000000000', usdc_base_units: '2500000000000' },
    total_lp_supply: '1000000000000',
    fee_bps: 30,
    spot_price_usdc_per_rpow_e9: '500000',
    seeded_at: '2026-05-11T00:00:00Z',
  } as any,
  refresh: vi.fn().mockResolvedValue(undefined),
  loading: false,
  error: null,
};
vi.mock('../hooks/useAmmPool.js', () => ({
  useAmmPool: () => poolMock,
}));

const ammMeMock = {
  ammMe: {
    email: 'me@test.com',
    usdc_base_units: '500000000',
    lp_balance: '0',
    terms_accepted_at: null as string | null,
    spot_price_usdc_per_rpow_e9: '500000',
    your_pool_share_bps: null,
  },
  refresh: vi.fn().mockResolvedValue(undefined),
  loading: false,
  error: null,
};
vi.mock('../hooks/useAmmMe.js', () => ({
  useAmmMe: () => ammMeMock,
}));

vi.mock('../api.js', () => ({
  api: {
    amm: {
      pool: vi.fn(),
      me: vi.fn(),
      quoteBuy: vi.fn(),
      quoteSell: vi.fn(),
      buy: vi.fn(),
      sell: vi.fn(),
      acceptTerms: vi.fn(),
    },
  },
}));
import { api } from '../api.js';
const quoteBuyMock = vi.mocked(api.amm.quoteBuy);
const buyMock = vi.mocked(api.amm.buy);
const acceptMock = vi.mocked(api.amm.acceptTerms);

function renderSwap() {
  return render(
    <MemoryRouter initialEntries={['/swap']}>
      <SwapPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  quoteBuyMock.mockReset();
  buyMock.mockReset();
  acceptMock.mockReset();
  ammMeMock.ammMe.terms_accepted_at = null;
  ammMeMock.refresh.mockClear();
  poolMock.refresh.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('SwapPage', () => {
  it('quote_debounce: only one quote call 300ms after last keystroke', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    quoteBuyMock.mockResolvedValue({
      rpow_out: '100000000', fee_base_units: '0', price_impact_bps: '0', spot_price_usdc_per_rpow_e9: '500000',
    });
    renderSwap();
    const input = screen.getByLabelText('amount in') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.change(input, { target: { value: '100' } });
    await vi.advanceTimersByTimeAsync(350);
    await waitFor(() => expect(quoteBuyMock).toHaveBeenCalledTimes(1));
    expect(quoteBuyMock).toHaveBeenCalledWith('100000000');
  });

  it('terms_gate_on_first_buy: BUY pops modal, accept then proceed', async () => {
    quoteBuyMock.mockResolvedValue({
      rpow_out: '100000000', fee_base_units: '0', price_impact_bps: '0', spot_price_usdc_per_rpow_e9: '500000',
    });
    acceptMock.mockResolvedValue({ accepted_at: '2026-05-11T00:00:00Z' });
    buyMock.mockResolvedValue({
      swap_id: 'SWAP_1', output_base_units: '100000000', fee_base_units: '0',
      pool_rpow_after: '0', pool_usdc_after: '0', signature_hex: '00', server_time: '2026-05-11T00:00:00Z',
    });
    renderSwap();
    fireEvent.change(screen.getByLabelText('amount in'), { target: { value: '1' } });
    await waitFor(() => expect(quoteBuyMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /BUY$/ }));
    await waitFor(() => expect(screen.queryByText(/Accept AMM terms/)).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /ACCEPT/ }));
    await waitFor(() => expect(acceptMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(buyMock).toHaveBeenCalledOnce());
    expect(buyMock).toHaveBeenCalledWith({
      usdc_base_units: '1000000',
      min_rpow_out: '99500000', // 0.5% slippage on 100000000
    });
  });

  it('terms_skipped_when_accepted: BUY proceeds without modal', async () => {
    ammMeMock.ammMe.terms_accepted_at = '2026-05-11T00:00:00Z';
    quoteBuyMock.mockResolvedValue({
      rpow_out: '100000000', fee_base_units: '0', price_impact_bps: '0', spot_price_usdc_per_rpow_e9: '500000',
    });
    buyMock.mockResolvedValue({
      swap_id: 'SWAP_1', output_base_units: '100000000', fee_base_units: '0',
      pool_rpow_after: '0', pool_usdc_after: '0', signature_hex: '00', server_time: '2026-05-11T00:00:00Z',
    });
    renderSwap();
    fireEvent.change(screen.getByLabelText('amount in'), { target: { value: '1' } });
    await waitFor(() => expect(quoteBuyMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /BUY$/ }));
    await waitFor(() => expect(buyMock).toHaveBeenCalledOnce());
    expect(acceptMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Accept AMM terms/)).toBeNull();
  });

  it('terms_cancel_aborts_write: cancel does not call buy', async () => {
    quoteBuyMock.mockResolvedValue({
      rpow_out: '100000000', fee_base_units: '0', price_impact_bps: '0', spot_price_usdc_per_rpow_e9: '500000',
    });
    renderSwap();
    fireEvent.change(screen.getByLabelText('amount in'), { target: { value: '1' } });
    await waitFor(() => expect(quoteBuyMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /BUY$/ }));
    await waitFor(() => expect(screen.queryByText(/Accept AMM terms/)).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /CANCEL/ }));
    await waitFor(() => expect(screen.queryByText(/Accept AMM terms/)).toBeNull());
    expect(buyMock).not.toHaveBeenCalled();
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it('slippage_to_min_out: 1% slippage produces 99% of quote in min_rpow_out', async () => {
    ammMeMock.ammMe.terms_accepted_at = '2026-05-11T00:00:00Z';
    quoteBuyMock.mockResolvedValue({
      rpow_out: '100000000', fee_base_units: '0', price_impact_bps: '0', spot_price_usdc_per_rpow_e9: '500000',
    });
    buyMock.mockResolvedValue({
      swap_id: 'SWAP_1', output_base_units: '100000000', fee_base_units: '0',
      pool_rpow_after: '0', pool_usdc_after: '0', signature_hex: '00', server_time: '2026-05-11T00:00:00Z',
    });
    renderSwap();
    fireEvent.change(screen.getByLabelText('slippage percent'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('amount in'), { target: { value: '1' } });
    await waitFor(() => expect(quoteBuyMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /BUY$/ }));
    await waitFor(() => expect(buyMock).toHaveBeenCalledWith({
      usdc_base_units: '1000000',
      min_rpow_out: '99000000', // 1% slippage
    }));
  });

  it('pool_not_seeded: renders empty state, no form', async () => {
    poolMock.pool = { seeded: false } as any;
    renderSwap();
    expect(screen.getByText(/pool not yet seeded/)).toBeTruthy();
    expect(screen.queryByLabelText('amount in')).toBeNull();
    poolMock.pool = {
      seeded: true,
      reserves: { rpow_base_units: '5000000000000000', usdc_base_units: '2500000000000' },
      total_lp_supply: '1000000000000', fee_bps: 30,
      spot_price_usdc_per_rpow_e9: '500000', seeded_at: '2026-05-11T00:00:00Z',
    } as any;
  });
});
```

- [ ] **Step 3: Run all tests**

Run: `cd apps/web && npx vitest run`

Expected: all tests pass including the 6 new Swap tests.

- [ ] **Step 4: Type-check**

Run: `cd apps/web && npx tsc -b`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Swap.tsx apps/web/src/pages/Swap.test.tsx
git commit -m "feat(amm): /swap page + component tests"
```

---

## Task 8: `Pool.tsx` page + component tests

**Files:**
- Create: `apps/web/src/pages/Pool.tsx`
- Create: `apps/web/src/pages/Pool.test.tsx`

- [ ] **Step 1: Implement `Pool.tsx`**

Create `apps/web/src/pages/Pool.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { AmmBanner } from '../components/AmmBanner.js';
import { WhatIsRpowPoolModal } from '../components/WhatIsRpowPoolModal.js';
import { useTermsGate } from '../components/TermsModal.js';
import { useMe } from '../hooks/useMe.js';
import { useAmmPool } from '../hooks/useAmmPool.js';
import { useAmmMe } from '../hooks/useAmmMe.js';
import { api, type AmmRecentSwap } from '../api.js';
import { formatRpow, parseRpowToBaseUnits } from '../lib/format.js';
import { minOut, formatUsdc, parseUsdcToBaseUnits, parsePercentToBps } from '../lib/amm.js';

export function PoolPage() {
  const { me } = useMe();
  const { pool, refresh: refreshPool } = useAmmPool();
  const { ammMe, refresh: refreshAmm } = useAmmMe();
  const [recent, setRecent] = useState<AmmRecentSwap[]>([]);

  // Add LP form
  const [addRpow, setAddRpow] = useState('');
  const [addUsdc, setAddUsdc] = useState('');
  const [addSlippage, setAddSlippage] = useState('0.5');
  const [addStatus, setAddStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [addError, setAddError] = useState('');

  // Remove LP form
  const [rmLp, setRmLp] = useState('');
  const [rmSlippage, setRmSlippage] = useState('0.5');
  const [rmStatus, setRmStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [rmError, setRmError] = useState('');

  const { ensureAccepted, modal } = useTermsGate(
    ammMe?.terms_accepted_at ?? null,
    refreshAmm,
  );

  // Fetch recent swaps on mount and after writes.
  async function loadRecent() {
    try {
      const r = await api.amm.swapsRecent();
      setRecent(r.swaps.slice(0, 5));
    } catch { /* ignore — non-critical */ }
  }
  useEffect(() => { loadRecent(); }, []);

  const ammDisallowed = (ammMe as any)?.error === 'NOT_ALLOWED';
  const seeded = pool && (pool as any).seeded === true;

  if (!me) return (
    <Panel title="POOL">
      <AmmBanner />
      <div>not signed in.</div>
      <div style={{ marginTop: 8 }}><Link to="/login">[ go to login ]</Link></div>
    </Panel>
  );

  if (ammDisallowed) return (
    <Panel title="POOL">
      <AmmBanner />
      <div>AMM access not enabled for your account.</div>
    </Panel>
  );

  if (pool && (pool as any).seeded === false) return (
    <Panel title="POOL">
      <AmmBanner />
      <pre style={{ margin: 0 }}>{`  pool not yet seeded.`}</pre>
      <div style={{ marginTop: 12, color: '#888', fontSize: 11 }}>
        <WhatIsRpowPoolModal />
      </div>
    </Panel>
  );

  if (!seeded || !pool) return (
    <Panel title="POOL">
      <AmmBanner />
      <div>loading...</div>
    </Panel>
  );

  const reserves = (pool as any).reserves as { rpow_base_units: string; usdc_base_units: string };
  const totalLp = BigInt((pool as any).total_lp_supply);
  const userLp = ammMe ? BigInt(ammMe.lp_balance) : 0n;
  const sharePct = totalLp > 0n ? Number((userLp * 10000n) / totalLp) / 100 : 0;
  const userRpowShare = totalLp > 0n ? (BigInt(reserves.rpow_base_units) * userLp) / totalLp : 0n;
  const userUsdcShare = totalLp > 0n ? (BigInt(reserves.usdc_base_units) * userLp) / totalLp : 0n;

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddStatus('sending'); setAddError('');
    try {
      const rpowBase = parseRpowToBaseUnits(addRpow);
      const usdcBase = parseUsdcToBaseUnits(addUsdc);
      const slippageBps = parsePercentToBps(addSlippage);
      // Estimate LP minted as min(rpow_in / pool_rpow, usdc_in / pool_usdc) * total_lp.
      const lpFromRpow = (BigInt(rpowBase) * totalLp) / BigInt(reserves.rpow_base_units);
      const lpFromUsdc = (BigInt(usdcBase) * totalLp) / BigInt(reserves.usdc_base_units);
      const estLp = lpFromRpow < lpFromUsdc ? lpFromRpow : lpFromUsdc;
      const minLpOut = minOut(estLp, slippageBps);
      if (!(await ensureAccepted())) {
        setAddStatus('idle');
        return;
      }
      await api.amm.lpAdd({
        rpow_base_units: rpowBase,
        usdc_base_units: usdcBase,
        min_lp_out: minLpOut.toString(),
      });
      setAddStatus('sent');
      await Promise.all([refreshPool(), refreshAmm(), loadRecent()]);
    } catch (err: any) {
      setAddStatus('error');
      setAddError(err?.message ?? err?.error ?? 'failed to add liquidity');
    }
  }

  async function submitRemove(e: React.FormEvent) {
    e.preventDefault();
    setRmStatus('sending'); setRmError('');
    try {
      const lpBase = parseRpowToBaseUnits(rmLp); // LP uses 9 decimals like RPOW
      const slippageBps = parsePercentToBps(rmSlippage);
      // Pro-rata estimate
      const estRpow = (BigInt(lpBase) * BigInt(reserves.rpow_base_units)) / totalLp;
      const estUsdc = (BigInt(lpBase) * BigInt(reserves.usdc_base_units)) / totalLp;
      if (!(await ensureAccepted())) {
        setRmStatus('idle');
        return;
      }
      await api.amm.lpRemove({
        lp_base_units: lpBase,
        min_rpow_out: minOut(estRpow, slippageBps).toString(),
        min_usdc_out: minOut(estUsdc, slippageBps).toString(),
      });
      setRmStatus('sent');
      await Promise.all([refreshPool(), refreshAmm(), loadRecent()]);
    } catch (err: any) {
      setRmStatus('error');
      setRmError(err?.message ?? err?.error ?? 'failed to remove liquidity');
    }
  }

  return (
    <Panel title="POOL">
      <AmmBanner />

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 'bold', marginBottom: 4 }}>POOL</div>
        reserves : {formatRpow(reserves.rpow_base_units)} RPOW  /  {formatUsdc(reserves.usdc_base_units)} USDC<br/>
        fee      : {((pool as any).fee_bps / 100).toFixed(2)}%<br/>
        your LP  : {formatRpow(userLp.toString())} LP  ({sharePct.toFixed(2)}% share)<br/>
        your RPOW share : {formatRpow(userRpowShare.toString())} RPOW<br/>
        your USDC share : {formatUsdc(userUsdcShare.toString())} USDC
      </div>

      <form onSubmit={submitAdd} style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 'bold', marginBottom: 4 }}>ADD LIQUIDITY</div>
        <div>RPOW IN  : <input
          type="text" inputMode="decimal" required value={addRpow}
          onChange={(e) => setAddRpow(e.target.value)} style={{ width: '14ch' }}
          aria-label="add rpow in"
        /> RPOW</div>
        <div>USDC IN  : <input
          type="text" inputMode="decimal" required value={addUsdc}
          onChange={(e) => setAddUsdc(e.target.value)} style={{ width: '14ch' }}
          aria-label="add usdc in"
        /> USDC</div>
        <div>SLIPPAGE : <input
          type="text" inputMode="decimal" required value={addSlippage}
          onChange={(e) => setAddSlippage(e.target.value)} style={{ width: '6ch' }}
          aria-label="add slippage percent"
        /> %</div>
        <div style={{ marginTop: 6 }}>
          <button type="submit" disabled={addStatus === 'sending'}>
            [ {addStatus === 'sending' ? '...' : 'ADD'} ]
          </button>
        </div>
        {addStatus === 'sent' && <pre style={{ margin: '6px 0 0' }}>  + LIQUIDITY ADDED</pre>}
        {addStatus === 'error' && <div className="error">error: {addError}</div>}
      </form>

      <form onSubmit={submitRemove} style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 'bold', marginBottom: 4 }}>REMOVE LIQUIDITY</div>
        <div>LP BURN  : <input
          type="text" inputMode="decimal" required value={rmLp}
          onChange={(e) => setRmLp(e.target.value)} style={{ width: '14ch' }}
          disabled={userLp === 0n}
          aria-label="remove lp burn"
        /> LP {userLp === 0n && <span style={{ color: '#888' }}>(no LP)</span>}</div>
        <div>SLIPPAGE : <input
          type="text" inputMode="decimal" required value={rmSlippage}
          onChange={(e) => setRmSlippage(e.target.value)} style={{ width: '6ch' }}
          disabled={userLp === 0n}
          aria-label="remove slippage percent"
        /> %</div>
        <div style={{ marginTop: 6 }}>
          <button type="submit" disabled={rmStatus === 'sending' || userLp === 0n}>
            [ {rmStatus === 'sending' ? '...' : 'REMOVE'} ]
          </button>
        </div>
        {rmStatus === 'sent' && <pre style={{ margin: '6px 0 0' }}>  + LIQUIDITY REMOVED</pre>}
        {rmStatus === 'error' && <div className="error">error: {rmError}</div>}
      </form>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 'bold', marginBottom: 4 }}>RECENT SWAPS</div>
        {recent.length === 0 ? (
          <div style={{ color: '#888' }}>(no swaps yet)</div>
        ) : (
          recent.map((s) => (
            <div key={s.id} style={{ fontSize: 12 }}>
              <span style={{ color: '#888' }}>{new Date(s.created_at).toLocaleTimeString()}</span>
              {' '}{s.direction}{' '}
              {s.direction === 'BUY'
                ? `${formatUsdc(s.usdc_delta_base_units)} USDC → ${formatRpow(s.rpow_delta_base_units)} RPOW`
                : `${formatRpow(s.rpow_delta_base_units)} RPOW → ${formatUsdc(s.usdc_delta_base_units)} USDC`}
            </div>
          ))
        )}
      </div>

      <div style={{ color: '#888', fontSize: 11 }}>
        <WhatIsRpowPoolModal />
      </div>
      {modal}
    </Panel>
  );
}
```

- [ ] **Step 2: Write component tests**

Create `apps/web/src/pages/Pool.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PoolPage } from './Pool.js';

vi.mock('../hooks/useMe.js', () => ({
  useMe: () => ({
    me: {
      email: 'me@test.com',
      balance_base_units: '1000000000000',
      minted_base_units: '0', sent_base_units: '0', received_base_units: '0',
      wrap_allowed: false, solana_wallet: null, x_handle: null, x_avatar_url: null,
      srpow_supply_owned_base_units: '0',
      daily_mint_cap_base_units: '0', daily_minted_base_units: '0', daily_remaining_base_units: '0',
      usdc_base_units: '500000000', amm_terms_accepted_at: null,
    },
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

const poolMock = {
  pool: {
    seeded: true,
    reserves: { rpow_base_units: '5000000000000000', usdc_base_units: '2500000000000' },
    total_lp_supply: '1000000000000', fee_bps: 30,
    spot_price_usdc_per_rpow_e9: '500000', seeded_at: '2026-05-11T00:00:00Z',
  } as any,
  refresh: vi.fn().mockResolvedValue(undefined),
  loading: false,
  error: null,
};
vi.mock('../hooks/useAmmPool.js', () => ({
  useAmmPool: () => poolMock,
}));

const ammMeMock = {
  ammMe: {
    email: 'me@test.com',
    usdc_base_units: '500000000',
    lp_balance: '0',
    terms_accepted_at: '2026-05-11T00:00:00Z' as string | null,
    spot_price_usdc_per_rpow_e9: '500000',
    your_pool_share_bps: null,
  },
  refresh: vi.fn().mockResolvedValue(undefined),
  loading: false,
  error: null,
};
vi.mock('../hooks/useAmmMe.js', () => ({
  useAmmMe: () => ammMeMock,
}));

vi.mock('../api.js', () => ({
  api: {
    amm: {
      lpAdd: vi.fn(),
      lpRemove: vi.fn(),
      acceptTerms: vi.fn(),
      swapsRecent: vi.fn().mockResolvedValue({ swaps: [] }),
    },
  },
}));
import { api } from '../api.js';
const lpAddMock = vi.mocked(api.amm.lpAdd);
const lpRemoveMock = vi.mocked(api.amm.lpRemove);
const acceptMock = vi.mocked(api.amm.acceptTerms);
const swapsRecentMock = vi.mocked(api.amm.swapsRecent);

function renderPool() {
  return render(
    <MemoryRouter initialEntries={['/pool']}>
      <PoolPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  lpAddMock.mockReset();
  lpRemoveMock.mockReset();
  acceptMock.mockReset();
  swapsRecentMock.mockReset();
  swapsRecentMock.mockResolvedValue({ swaps: [] });
  ammMeMock.ammMe.terms_accepted_at = '2026-05-11T00:00:00Z';
  ammMeMock.ammMe.lp_balance = '0';
});
afterEach(() => cleanup());

describe('PoolPage', () => {
  it('stats_render_from_pool_payload', async () => {
    renderPool();
    expect(screen.getByText(/reserves/)).toBeTruthy();
    expect(screen.getByText(/fee/)).toBeTruthy();
    expect(screen.getByText(/your LP/)).toBeTruthy();
  });

  it('no_lp_disables_remove', async () => {
    renderPool();
    expect(screen.getByLabelText('remove lp burn')).toBeDisabled();
    expect(screen.getByRole('button', { name: /REMOVE/ })).toBeDisabled();
  });

  it('add_lp_with_terms_already_accepted', async () => {
    lpAddMock.mockResolvedValue({
      event_id: 'EV1', lp_minted: '0', rpow_consumed: '0', usdc_consumed: '0',
      signature_hex: '00', server_time: '2026-05-11T00:00:00Z',
    });
    renderPool();
    fireEvent.change(screen.getByLabelText('add rpow in'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('add usdc in'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: /^\[ ADD \]$/ }));
    await waitFor(() => expect(lpAddMock).toHaveBeenCalledOnce());
    expect(acceptMock).not.toHaveBeenCalled();
    const body = lpAddMock.mock.calls[0][0];
    expect(body.rpow_base_units).toBe('1000000000000');
    expect(body.usdc_base_units).toBe('500000000');
    expect(typeof body.min_lp_out).toBe('string');
  });

  it('add_lp_with_terms_gate_modal', async () => {
    ammMeMock.ammMe.terms_accepted_at = null;
    lpAddMock.mockResolvedValue({
      event_id: 'EV1', lp_minted: '0', rpow_consumed: '0', usdc_consumed: '0',
      signature_hex: '00', server_time: '2026-05-11T00:00:00Z',
    });
    acceptMock.mockResolvedValue({ accepted_at: '2026-05-11T00:00:00Z' });
    renderPool();
    fireEvent.change(screen.getByLabelText('add rpow in'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('add usdc in'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: /^\[ ADD \]$/ }));
    await waitFor(() => expect(screen.queryByText(/Accept AMM terms/)).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /ACCEPT/ }));
    await waitFor(() => expect(acceptMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(lpAddMock).toHaveBeenCalledOnce());
  });

  it('remove_lp_enabled_when_has_lp', async () => {
    ammMeMock.ammMe.lp_balance = '500000000000';
    lpRemoveMock.mockResolvedValue({
      event_id: 'EV1', rpow_received: '0', usdc_received: '0',
      signature_hex: '00', server_time: '2026-05-11T00:00:00Z',
    });
    renderPool();
    expect(screen.getByLabelText('remove lp burn')).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('remove lp burn'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /^\[ REMOVE \]$/ }));
    await waitFor(() => expect(lpRemoveMock).toHaveBeenCalledOnce());
  });

  it('recent_swaps_empty_state', async () => {
    swapsRecentMock.mockResolvedValue({ swaps: [] });
    renderPool();
    await waitFor(() => expect(screen.getByText(/no swaps yet/)).toBeTruthy());
  });

  it('recent_swaps_renders_list', async () => {
    swapsRecentMock.mockResolvedValue({
      swaps: [{
        id: 'S1', x_handle: null, direction: 'BUY',
        rpow_delta_base_units: '100000000', usdc_delta_base_units: '50000000',
        fee_base_units: '150000', pool_rpow_after: '0', pool_usdc_after: '0',
        created_at: '2026-05-11T14:00:00Z',
      }],
    });
    renderPool();
    await waitFor(() => expect(screen.queryByText(/BUY/)).not.toBeNull());
  });
});
```

- [ ] **Step 3: Run all tests**

Run: `cd apps/web && npx vitest run`

Expected: all tests pass (including the 7 new Pool tests).

- [ ] **Step 4: Type-check**

Run: `cd apps/web && npx tsc -b`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Pool.tsx apps/web/src/pages/Pool.test.tsx
git commit -m "feat(amm): /pool page + component tests"
```

---

## Task 9: `App.tsx` — wire routes + NavLinks

**Files:**
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Read the current App.tsx to confirm structure**

Run: `grep -n "Route\|NavLink" apps/web/src/App.tsx`

Expected: see existing `<Route path=...>` and `<NavLink>` entries.

- [ ] **Step 2: Add imports for the new pages**

In the imports section of `apps/web/src/App.tsx`, alongside existing page imports, add:

```tsx
import { SwapPage } from './pages/Swap.js';
import { PoolPage } from './pages/Pool.js';
```

- [ ] **Step 3: Register the routes**

In the `<Routes>` block, immediately after `<Route path="/wallet" element={<WalletPage />} />`, add:

```tsx
            <Route path="/swap" element={<SwapPage />} />
            <Route path="/pool" element={<PoolPage />} />
```

- [ ] **Step 4: Add NavLinks**

In the nav section (look for the existing `<NavLink to="/wallet">` etc), add two new NavLinks alongside the existing ones. Use the same className / styling pattern as the existing NavLinks:

```tsx
<NavLink to="/swap">swap</NavLink>
<NavLink to="/pool">pool</NavLink>
```

Place them visually between `wallet` and `mine` if possible — the user mainly cares that they appear in the nav, not exact ordering.

- [ ] **Step 5: Type-check + run all tests**

Run: `cd apps/web && npx tsc -b && npx vitest run`

Expected: tsc exit 0, all tests pass.

- [ ] **Step 6: Build the app to catch any final issues**

Run: `cd apps/web && npm run build 2>&1 | tail -20`

Expected: vite build succeeds. If it fails, fix the error and re-run.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(amm): wire /swap and /pool routes + NavLinks"
```

---

## Self-review notes

- **Spec coverage:**
  - Visual style "match terminal" — Tasks 4–8 all use Panel + monospace + ASCII forms.
  - Routes & navigation — Task 9.
  - Wallet USDC row — Task 6.
  - AMM Banner — Task 4.
  - Terms-modal gated on first write — Task 5 + used in Task 7 and Task 8.
  - WhatIsRpowPoolModal — Task 4.
  - useAmmPool 10s poll — Task 3.
  - useAmmMe — Task 3.
  - api.amm namespace — Task 2.
  - lib/amm.ts pure helpers + tests — Task 1.
  - Quote debounce 300ms — Task 7 (with test).
  - Slippage → min-out — Task 1 (helper) + Task 7 / 8 (consumers).
  - Pool not initialized empty state — Task 7 (with test) + Task 8.
  - Not signed in empty state — Tasks 7 and 8.
  - AMM allowlist (NOT_ALLOWED) empty state — Tasks 7 and 8.
  - LP-remove disabled with no LP — Task 8 (with test).
  - Recent swaps list + empty state — Task 8 (with two tests).
  - 5 named Swap tests — Task 7 (delivers 6).
  - 6 named Pool tests — Task 8 (delivers 7).
  - amm.test.ts pure helper tests — Task 1 (delivers 25+).
- **Placeholder scan:** none. Every code block is complete.
- **Type consistency:** `useTermsGate(termsAcceptedAt, onAccepted)` signature used identically in Tasks 5, 7, 8. `AmmPoolResponse`/`AmmMeResponse` types defined in Task 2 and consumed in Tasks 3, 7, 8 with matching field access (`reserves.rpow_base_units`, `total_lp_supply`, `terms_accepted_at`, `lp_balance`, etc.). `minOut` signature `(bigint, number) => bigint` matches in Task 1 definition and Task 7/8 calls.
- **Known field shapes verified against server code:** request bodies for `/amm/buy`, `/amm/sell`, `/amm/lp/add`, `/amm/lp/remove` match the Zod schemas in `apps/server/src/routes/amm/{swap.ts,lp.ts}` (no `idempotency_key`).
