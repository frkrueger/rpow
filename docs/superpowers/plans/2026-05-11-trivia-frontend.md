# Trivia Frontend (Slices 4 + 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `apps/web-trivia/` SPA — auth gate, header, KPI strip, lobby, chat, recent matches, and the heart of the UX: `TriviaMatchModal` with a server-anchored countdown clock, 4 large choice buttons, and a result reveal showing both answers and the correct one.

**Architecture:** Clone the established `apps/web-gladiator/` structure, swap gladiator endpoints for trivia, rebuild the match flow (gladiator's instant `FlipModal` becomes a richer multi-state modal with question/choices/countdown/result). HTTP polling: 5s lobby/chat/recent, 2s `/matches/active` while you have an open session, 1s `/matches/:id` while in an ACTIVE match so the countdown feels responsive. X-handle verification reuses gladiator's existing endpoints (per spec §3 — trivia and gladiator share user identity).

**Tech Stack:** React 18 + TypeScript + Vite. No router. Single `App.tsx` with state-machine for view modes (spectator / unverified / verified). 5 sibling React components. Identical look-and-feel as `gladiator.rpow2.com` (same `styles.css` copied over).

---

## File Structure

`apps/web-trivia/` mirrors `apps/web-gladiator/` exactly:

**Create:**
- `apps/web-trivia/package.json` — `"@rpow/web-trivia"` workspace member, react 18 + vite + vitest deps
- `apps/web-trivia/vite.config.ts`
- `apps/web-trivia/tsconfig.json`
- `apps/web-trivia/index.html`
- `apps/web-trivia/netlify.toml` (placeholder for slice 6 deploy)
- `apps/web-trivia/src/main.tsx` — root mount + forwarded-session handshake from rpow2.com → `.rpow2.com` cookie
- `apps/web-trivia/src/styles.css` — copied verbatim from web-gladiator (one shared visual identity)
- `apps/web-trivia/src/api.ts` — typed fetchers for every `/api/trivia/*` endpoint + the shared `/me`, `/api/gladiator/x-handle/*` endpoints
- `apps/web-trivia/src/XHandleClaimModal.tsx` — verbatim clone, hits the shared `/api/gladiator/x-handle/*` endpoints
- `apps/web-trivia/src/EnterArenaForm.tsx` — clone of gladiator's, rename "flip" → "match" in copy
- `apps/web-trivia/src/YourSessionPanel.tsx` — clone, rename "flips" → "matches" in copy
- `apps/web-trivia/src/App.tsx` — header / KPI strip / 2-col layout / polling
- `apps/web-trivia/src/TriviaMatchModal.tsx` — multi-state modal (loading / active-with-countdown / result)

**Modify:**
- `package.json` (repo root) — add `apps/web-trivia` to `workspaces` array if it isn't already a `*` glob.

---

## Conventions

- API base URL: identical pattern to gladiator — `https://api.rpow2.com` in prod, `http://localhost:8080` when `window.location.hostname === 'localhost'`. All fetches use `credentials: 'include'` so the `.rpow2.com` cookie travels.
- Money: backend returns base-units as decimal strings (`"100000000"`). Frontend uses `BigInt` for arithmetic and the shared `formatRpow` helper (re-implemented in this app's `api.ts` — same code as gladiator's) for display.
- Server-authoritative time: countdown clock derived from `deadline_at` (ISO string from server) minus `Date.now()`. Local clock drift of a few seconds doesn't matter — when the timer hits 0 client-side, we wait for `/matches/:id` to flip state to RESOLVED. We do NOT auto-submit an empty answer; the backend already treats "no answer at deadline" as a timeout for that side, and the lazy-resolve poll path returns the final state.
- The `*_choice_idx` is HIDDEN until `state='RESOLVED'` (the backend already enforces this — the frontend just needs to display whichever fields are present).

---

## Task 1: Scaffold + api.ts

**Files:**
- Create: `apps/web-trivia/package.json`
- Create: `apps/web-trivia/vite.config.ts`
- Create: `apps/web-trivia/tsconfig.json`
- Create: `apps/web-trivia/index.html`
- Create: `apps/web-trivia/netlify.toml`
- Create: `apps/web-trivia/src/main.tsx`
- Create: `apps/web-trivia/src/styles.css` (copied from gladiator's)
- Create: `apps/web-trivia/src/api.ts`

- [ ] **Step 1: Scaffold config files**

```bash
mkdir -p apps/web-trivia/src
```

`apps/web-trivia/package.json`:

```json
{
  "name": "@rpow/web-trivia",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --port 5176",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.4.0",
    "vite": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

`apps/web-trivia/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
```

`apps/web-trivia/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "node"],
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

`apps/web-trivia/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>RPOW Trivia</title>
  <link rel="icon" type="image/svg+xml" href="https://rpow2.com/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap">
  <link rel="stylesheet" href="/src/styles.css">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

`apps/web-trivia/netlify.toml`:

```toml
# Netlify site config for trivia.rpow2.com.
#
# Set "Base directory" in the Netlify dashboard to apps/web-trivia/.
# Netlify reads this file from that base dir; `publish` and the working
# dir for `command` are also relative to the base. `npm ci --workspaces`
# must run from the workspace root, so the command starts with `cd ../..`
# to get back to the repo root before installing.

[build]
  command = "cd ../.. && npm ci --workspaces --include-workspace-root && npm run build --workspace @rpow/web-trivia"
  publish = "dist"

[build.environment]
  NODE_VERSION = "22.20.0"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"

# SPA fallback — every route serves index.html so client routing works.
[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200

# Production builds use the VPS-hosted API at api.rpow2.com.
# Server-side CORS already allows https://trivia.rpow2.com per slice 1
# (TRIVIA_WEB_ORIGIN env var, wired into Fastify's allowedOrigins list).
[context.production.environment]
  VITE_API_BASE_URL = "https://api.rpow2.com"

[context.deploy-preview.environment]
  VITE_API_BASE_URL = "https://api.rpow2.com"
```

`apps/web-trivia/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const SESSION_TTL = 2592000; // 30 days — matches the AuthCallback on rpow2.com

// Forwarded-session handshake. When someone clicks RPOW Trivia from
// rpow2.com's /apps with forwardSession=true, the URL arrives as
// https://trivia.rpow2.com/#/auth-callback?s=<token>. Set the .rpow2.com
// cookie on this origin before React mounts so the very first fetchMe sees
// the session. Strip the fragment afterwards so refreshes don't replay.
(function maybeAdoptForwardedSession() {
  const m = window.location.hash.match(/[?&]s=([^&]+)/);
  if (!m) return;
  const token = decodeURIComponent(m[1]);
  document.cookie = `rpow_session=${token}; Path=/; Max-Age=${SESSION_TTL}; SameSite=Lax; Domain=.rpow2.com; Secure`;
  history.replaceState(null, '', window.location.pathname + window.location.search);
})();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
```

`apps/web-trivia/src/styles.css`: copy verbatim from `/Users/fredkrueger/rpow/apps/web-gladiator/src/styles.css`:

```bash
cp apps/web-gladiator/src/styles.css apps/web-trivia/src/styles.css
```

- [ ] **Step 2: Implement api.ts**

`apps/web-trivia/src/api.ts`:

```ts
const API_BASE = (() => {
  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
    return 'http://localhost:8080';
  }
  return 'https://api.rpow2.com';
})();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Me {
  email: string;
  balance_base_units: string;
}

export interface SessionRow {
  id: string;
  bet_base_units: string;
  bankroll_initial_base_units: string;
  bankroll_remaining_base_units: string;
  matches_won: number;
  matches_lost: number;
  status: 'OPEN' | 'CLOSED';
  opened_at: string;
  last_match_at: string | null;
}

export interface TriviaProfile {
  email: string;
  x_handle: string | null;
  x_handle_verified_at: string | null;
  x_avatar_url: string | null;
  open_session: SessionRow | null;
  career: { wins: number; losses: number };
}

export interface LobbyEntry {
  session_id: string;
  account_email: string;
  x_handle: string;
  x_avatar_url: string | null;
  bet_base_units: string;
  bankroll_remaining_base_units: string;
  matches_won: number;
  matches_lost: number;
  opened_at: string;
  last_match_at: string | null;
}

export interface RecentMatch {
  id: string;
  offerer_email: string;
  challenger_email: string;
  offerer_x_handle: string | null;
  challenger_x_handle: string | null;
  bet_base_units: string;
  winner_email: string;
  offerer_choice_idx: number | null;
  challenger_choice_idx: number | null;
  question_id: string;
  created_at: string;
  resolved_at: string;
}

export interface ChatMessage {
  id: string;
  account_email: string | null;
  x_handle: string | null;
  kind: 'USER' | 'SYSTEM';
  body: string;
  created_at: string;
}

export interface TriviaStats {
  total_matches: number;
  total_volume_base_units: string;
  total_verified_users: number;
  open_arena_count: number;
}

export interface XHandleStartResponse {
  code: string;
  tweet_intent_url: string;
  expires_at: string;
}

/** The poll payload returned by GET /matches/active and GET /matches/:id. */
export interface MatchPollPayload {
  id: string;
  state: 'ACTIVE' | 'RESOLVED';
  offerer_email: string;
  challenger_email: string;
  offerer_x_handle: string | null;
  challenger_x_handle: string | null;
  bet_base_units: string;
  question_id: string;
  question: string;
  choices: string[];
  correct_choice_idx: number | null;            // null while ACTIVE
  offerer_choice_idx: number | null;            // null until RESOLVED (server hides it)
  offerer_answered: boolean;                    // visible — "opponent has answered"
  offerer_answered_at: string | null;           // null until RESOLVED
  challenger_choice_idx: number | null;
  challenger_answered: boolean;
  challenger_answered_at: string | null;
  winner_email: string | null;                  // null while ACTIVE
  signature_hex: string | null;                 // null while ACTIVE
  deadline_at: string;                          // ISO; drives the countdown
  created_at: string;
  resolved_at: string | null;
}

/** Response from POST /matches/start. */
export interface MatchStartResponse {
  match_id: string;
  question_id: string;
  question: string;
  choices: string[];
  bet_base_units: string;
  deadline_at: string;
}

// ---------------------------------------------------------------------------
// Fetchers — auth + identity
// ---------------------------------------------------------------------------

export async function fetchMe(): Promise<Me | null> {
  const res = await fetch(`${API_BASE}/me`, { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`me ${res.status}`);
  return res.json();
}

export async function fetchTriviaMe(): Promise<TriviaProfile | null> {
  const res = await fetch(`${API_BASE}/api/trivia/me`, { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`trivia/me ${res.status}`);
  return res.json();
}

/** Trivia reuses gladiator's X-handle verification flow (same db column). */
export async function startXVerification(handle: string): Promise<XHandleStartResponse> {
  const res = await fetch(`${API_BASE}/api/gladiator/x-handle/start`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `x-handle/start ${res.status}`);
  }
  return res.json();
}

export async function verifyXTweet(tweetUrl: string): Promise<{ x_handle: string; x_handle_verified_at: string; x_avatar_url: string }> {
  const res = await fetch(`${API_BASE}/api/gladiator/x-handle/verify`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tweet_url: tweetUrl }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `x-handle/verify ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Fetchers — lobby / stats / chat / recent
// ---------------------------------------------------------------------------

export async function fetchLobby(): Promise<LobbyEntry[]> {
  const res = await fetch(`${API_BASE}/api/trivia/lobby`, { credentials: 'include' });
  if (!res.ok) return [];
  const body = await res.json();
  return body.players ?? [];
}

export async function fetchRecentMatches(): Promise<RecentMatch[]> {
  const res = await fetch(`${API_BASE}/api/trivia/matches/recent`, { credentials: 'include' });
  if (!res.ok) return [];
  const body = await res.json();
  return body.matches ?? [];
}

export async function fetchChat(before?: string): Promise<ChatMessage[]> {
  const url = before
    ? `${API_BASE}/api/trivia/chat?before=${encodeURIComponent(before)}`
    : `${API_BASE}/api/trivia/chat`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) return [];
  const body = await res.json();
  return body.messages ?? [];
}

export async function postChat(body: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/trivia/chat`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `chat ${res.status}`);
  }
}

export async function fetchTriviaStats(): Promise<TriviaStats | null> {
  const res = await fetch(`${API_BASE}/api/trivia/stats`, { credentials: 'omit' });
  if (!res.ok) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// Fetchers — sessions
// ---------------------------------------------------------------------------

export async function enterArena(bankrollBaseUnits: string, betBaseUnits: string): Promise<{
  session_id: string;
  bet_base_units: string;
  bankroll_initial_base_units: string;
  bankroll_remaining_base_units: string;
  status: 'OPEN';
  opened_at: string;
}> {
  const res = await fetch(`${API_BASE}/api/trivia/sessions`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bankroll_base_units: bankrollBaseUnits, bet_base_units: betBaseUnits }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `enterArena ${res.status}`);
  }
  return res.json();
}

export async function closeSession(sessionId: string): Promise<{ status: string; closed_at: string; refunded_base_units: string }> {
  const res = await fetch(`${API_BASE}/api/trivia/sessions/${sessionId}/close`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `closeSession ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Fetchers — match flow
// ---------------------------------------------------------------------------

/** Challenger starts a match. */
export async function startMatch(sessionId: string): Promise<MatchStartResponse> {
  const res = await fetch(`${API_BASE}/api/trivia/matches/start`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `start ${res.status}`);
  }
  return res.json();
}

/** Either side submits their answer. */
export async function submitAnswer(matchId: string, choiceIdx: number): Promise<{ answered_at: string; both_answered: boolean }> {
  const res = await fetch(`${API_BASE}/api/trivia/matches/${matchId}/answer`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ choice_idx: choiceIdx }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `answer ${res.status}`);
  }
  return res.json();
}

/** Offerer-side poll: returns the in-flight (or freshly resolved) match for a session. */
export async function fetchActiveMatch(sessionId: string): Promise<MatchPollPayload | null> {
  const res = await fetch(`${API_BASE}/api/trivia/matches/active?session_id=${encodeURIComponent(sessionId)}`, {
    credentials: 'include',
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body.match ?? null;
}

/** Both-side poll: full state of one match by id. */
export async function fetchMatch(matchId: string): Promise<MatchPollPayload | null> {
  const res = await fetch(`${API_BASE}/api/trivia/matches/${matchId}`, {
    credentials: 'include',
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body.match ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatRpow(baseUnitsStr: string): string {
  const big = BigInt(baseUnitsStr);
  const sign = big < 0n ? '-' : '';
  const abs = big < 0n ? -big : big;
  const denom = 1_000_000_000n;
  const whole = abs / denom;
  const frac = abs % denom;
  if (frac === 0n) return `${sign}${whole}`;
  return `${sign}${whole}.${frac.toString().padStart(9, '0').replace(/0+$/, '')}`;
}
```

- [ ] **Step 3: Install + typecheck**

```
cd /Users/fredkrueger/rpow && npm install
cd apps/web-trivia && npx tsc --noEmit
```

Expected: typecheck passes (App.tsx doesn't exist yet — temporary error is fine; if so, create a placeholder `apps/web-trivia/src/App.tsx` that just exports `export function App() { return null; }` to make tsc happy).

- [ ] **Step 4: Commit**

```bash
git add apps/web-trivia/
git commit -m "feat(trivia-web): scaffold web-trivia + api.ts"
```

---

## Task 2: XHandleClaimModal + EnterArenaForm + YourSessionPanel

**Files:**
- Create: `apps/web-trivia/src/XHandleClaimModal.tsx`
- Create: `apps/web-trivia/src/EnterArenaForm.tsx`
- Create: `apps/web-trivia/src/YourSessionPanel.tsx`

These are near-verbatim clones of the gladiator counterparts with the gladiator → trivia naming swap.

- [ ] **Step 1: XHandleClaimModal**

Copy `apps/web-gladiator/src/XHandleClaimModal.tsx` to `apps/web-trivia/src/XHandleClaimModal.tsx` verbatim. The imports already pull from `./api.js` and the api.ts in web-trivia exports `startXVerification` / `verifyXTweet` / `XHandleStartResponse` with identical signatures. No changes needed beyond the file location.

```bash
cp apps/web-gladiator/src/XHandleClaimModal.tsx apps/web-trivia/src/XHandleClaimModal.tsx
```

- [ ] **Step 2: EnterArenaForm**

Copy and rename "flip" → "match" / "flips" → "matches" in copy. Final content for `apps/web-trivia/src/EnterArenaForm.tsx`:

```tsx
import { useState } from 'react';
import { enterArena, formatRpow } from './api.js';

interface Props {
  balanceBaseUnits: string;
  onEntered: () => void;
}

const MIN_BET = 10_000_000n;            // 0.01 RPOW
const MAX_BET = 10_000_000_000n;        // 10 RPOW
const MAX_BANKROLL = 100_000_000_000n;  // 100 RPOW

export function EnterArenaForm({ balanceBaseUnits, onEntered }: Props) {
  const [bet, setBet] = useState<bigint>(MIN_BET);
  const [bankrollMultiple, setBankrollMultiple] = useState<number>(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bankroll = bet * BigInt(bankrollMultiple);
  const balance = BigInt(balanceBaseUnits);
  const tooExpensive = bankroll > balance;
  const tooLarge = bankroll > MAX_BANKROLL;

  async function onEnter() {
    setError(null); setBusy(true);
    try {
      await enterArena(bankroll.toString(), bet.toString());
      onEntered();
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <h2>ENTER THE ARENA</h2>
      <p style={{ fontSize: 12, color: '#888' }}>
        Commit a bankroll. Other players challenge you one match at a time until you drain or leave. Each match is one trivia question with 10 seconds to answer.
      </p>
      <div style={{ marginTop: 12 }}>
        <label>Bet per match (RPOW):</label>
        <select
          value={bet.toString()}
          onChange={e => setBet(BigInt(e.target.value))}
          disabled={busy}
        >
          <option value={MIN_BET.toString()}>0.01</option>
          <option value={(MIN_BET * 10n).toString()}>0.1</option>
          <option value={(MIN_BET * 100n).toString()}>1</option>
          <option value={MAX_BET.toString()}>10</option>
        </select>
      </div>
      <div style={{ marginTop: 12 }}>
        <label>Bankroll (matches × bet):</label>
        <select
          value={bankrollMultiple.toString()}
          onChange={e => setBankrollMultiple(parseInt(e.target.value, 10))}
          disabled={busy}
        >
          {[1, 2, 5, 10, 25, 50, 100].map(n => (
            <option key={n} value={n}>
              {n} × {formatRpow(bet.toString())} = {formatRpow((bet * BigInt(n)).toString())} RPOW
            </option>
          ))}
        </select>
      </div>
      <div style={{ marginTop: 12, fontSize: 12, color: '#888' }}>
        Your balance: {formatRpow(balanceBaseUnits)} RPOW
      </div>
      <button
        style={{ marginTop: 12 }}
        onClick={onEnter}
        disabled={busy || tooExpensive || tooLarge}
      >
        {busy ? 'entering...' : `[ ENTER ARENA — ${formatRpow(bankroll.toString())} RPOW ]`}
      </button>
      {tooExpensive && <div className="error" style={{marginTop:8}}>not enough balance</div>}
      {tooLarge && <div className="error" style={{marginTop:8}}>bankroll exceeds 100 RPOW cap</div>}
      {error && <div className="error" style={{marginTop:8}}>{error}</div>}
    </div>
  );
}
```

- [ ] **Step 3: YourSessionPanel**

`apps/web-trivia/src/YourSessionPanel.tsx`:

```tsx
import { useState } from 'react';
import { closeSession, formatRpow, type SessionRow } from './api.js';

interface Props {
  session: SessionRow;
  onClosed: () => void;
}

export function YourSessionPanel({ session, onClosed }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onLeave() {
    setError(null); setBusy(true);
    try {
      await closeSession(session.id);
      onClosed();
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  const remaining = BigInt(session.bankroll_remaining_base_units);
  const bet = BigInt(session.bet_base_units);
  const matchesRemaining = bet > 0n ? remaining / bet : 0n;

  return (
    <div className="panel">
      <h2>YOUR SESSION</h2>
      <div style={{ marginTop: 8 }}>
        Bankroll: <strong>{formatRpow(session.bankroll_remaining_base_units)} RPOW</strong> ({matchesRemaining.toString()} matches at {formatRpow(session.bet_base_units)} RPOW each)
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: '#aaa' }}>
        W/L this session: <strong>{session.matches_won}</strong> / <strong>{session.matches_lost}</strong>
      </div>
      <button
        style={{ marginTop: 12 }}
        onClick={onLeave}
        disabled={busy}
      >
        {busy ? 'leaving...' : '[ LEAVE ARENA ]'}
      </button>
      {error && <div className="error" style={{marginTop:8}}>{error}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck and commit**

```
cd apps/web-trivia && npx tsc --noEmit
```

If there's an "App.tsx not found" type error, leave the placeholder from Task 1 in place — it'll be replaced in Task 3.

```bash
git add apps/web-trivia/src/{XHandleClaimModal,EnterArenaForm,YourSessionPanel}.tsx
git commit -m "feat(trivia-web): XHandleClaimModal + EnterArenaForm + YourSessionPanel"
```

---

## Task 3: App.tsx — layout + polling + auth state machine

**Files:**
- Modify (replace placeholder): `apps/web-trivia/src/App.tsx`

This is the orchestrator. Mirrors `apps/web-gladiator/src/App.tsx` closely but:
- Uses trivia fetchers
- KPI strip labels: "total matches", "RPOW wagered", "in arena", "verified players" (the `TriviaStats` shape provides `total_matches`, `total_volume_base_units`, `open_arena_count`, `total_verified_users`)
- Lobby panel uses `LobbyEntry` (W/L is `matches_won`/`matches_lost`)
- Recent matches panel: "X beat Y for Z RPOW" using `RecentMatch`
- Clicking `[ CHALLENGE @user ]` sets state that opens `TriviaMatchModal` for the challenger flow
- An offerer with `open_session` gets the modal AUTO-opened when `fetchActiveMatch` returns a match (handled in Task 4 — but stub the spot in App.tsx now)
- Chat auto-scrolls to bottom on new messages (same `chatScrollRef` pattern as the latest gladiator)

- [ ] **Step 1: Write the App**

Full content for `apps/web-trivia/src/App.tsx`:

```tsx
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  fetchMe, fetchTriviaMe, fetchLobby, fetchRecentMatches, fetchChat, fetchTriviaStats, postChat,
  fetchActiveMatch, formatRpow,
  type Me, type TriviaProfile, type LobbyEntry, type RecentMatch, type ChatMessage,
  type TriviaStats, type MatchPollPayload,
} from './api.js';
import { XHandleClaimModal } from './XHandleClaimModal.js';
import { EnterArenaForm } from './EnterArenaForm.js';
import { YourSessionPanel } from './YourSessionPanel.js';
import { TriviaMatchModal } from './TriviaMatchModal.js';

function XLink({ handle }: { handle: string | null | undefined }) {
  if (!handle) return <span>—</span>;
  return (
    <a
      href={`https://x.com/${handle}`}
      target="_blank"
      rel="noreferrer noopener"
      className="x-handle"
    >@{handle}</a>
  );
}

function linkifyHandles(text: string): ReactNode[] {
  const re = /(@[A-Za-z0-9_]{1,15})/g;
  const parts = text.split(re);
  return parts.map((part, i) => {
    if (part.startsWith('@')) {
      const handle = part.slice(1);
      return <XLink key={i} handle={handle} />;
    }
    return part;
  });
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [profile, setProfile] = useState<TriviaProfile | null>(null);
  const [lobby, setLobby] = useState<LobbyEntry[]>([]);
  const [recent, setRecent] = useState<RecentMatch[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [stats, setStats] = useState<TriviaStats | null>(null);
  const [authState, setAuthState] = useState<'loading' | 'spectator' | 'unverified' | 'verified'>('loading');

  // Modal state. `challengeTarget` is the lobby row the user clicked CHALLENGE on
  // (challenger-side modal). `incomingMatchId` is set when /matches/active
  // surfaces an in-flight match for the offerer (offerer-side modal).
  const [challengeTarget, setChallengeTarget] = useState<LobbyEntry | null>(null);
  const [incomingMatchId, setIncomingMatchId] = useState<string | null>(null);

  const [chatDraft, setChatDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  async function sendChat() {
    const body = chatDraft.trim();
    if (!body || chatBusy) return;
    setChatError(null);
    setChatBusy(true);
    try {
      await postChat(body);
      setChatDraft('');
      const fresh = await fetchChat().catch(() => []);
      setChat(fresh);
    } catch (e: any) {
      setChatError(e.message);
    } finally {
      setChatBusy(false);
    }
  }

  async function refreshAll() {
    const [u, p] = await Promise.all([
      fetchMe().catch(() => null),
      fetchTriviaMe().catch(() => null),
    ]);
    setMe(u);
    setProfile(p);
    if (!u) setAuthState('spectator');
    else if (!p || !p.x_handle_verified_at) setAuthState('unverified');
    else setAuthState('verified');

    const [l, r, c, s] = await Promise.all([
      fetchLobby().catch(() => []),
      fetchRecentMatches().catch(() => []),
      fetchChat().catch(() => []),
      fetchTriviaStats().catch(() => null),
    ]);
    setLobby(l);
    setRecent(r);
    setChat(c);
    if (s) setStats(s);
  }

  useEffect(() => { refreshAll(); }, []);

  // Slow poll: lobby / chat / recent + stats every 5s.
  useEffect(() => {
    const t = setInterval(async () => {
      const [l, r, c, s] = await Promise.all([
        fetchLobby().catch(() => []),
        fetchRecentMatches().catch(() => []),
        fetchChat().catch(() => []),
        fetchTriviaStats().catch(() => null),
      ]);
      setLobby(l); setRecent(r); setChat(c);
      if (s) setStats(s);
    }, 5000);
    return () => clearInterval(t);
  }, []);

  // Offerer-side incoming-match watcher: poll /matches/active every 2s while
  // we have an open session. When it surfaces an in-flight match that we
  // haven't already opened a modal for, open the modal for the offerer.
  const myOpenSession = profile?.open_session ?? null;
  useEffect(() => {
    if (!myOpenSession || incomingMatchId || challengeTarget) return;
    const sid = myOpenSession.id;
    let cancelled = false;
    const tick = async () => {
      const m: MatchPollPayload | null = await fetchActiveMatch(sid).catch(() => null);
      if (cancelled) return;
      if (m) {
        setIncomingMatchId(m.id);
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, [myOpenSession?.id, incomingMatchId, challengeTarget]);

  return (
    <div className="app">
      <header>
        <h1>RPOW TRIVIA</h1>
        <div className="auth-bar">
          {me
            ? <span>logged in as {profile?.x_handle ? <XLink handle={profile.x_handle} /> : <strong>{me.email}</strong>}</span>
            : <a href="https://rpow2.com/#/">[ sign in at rpow2.com ]</a>
          }
        </div>
      </header>

      {stats && (
        <div className="kpi-strip">
          <div className="kpi-cell">
            <div className="kpi-num">{stats.total_matches.toLocaleString()}</div>
            <div className="kpi-label">total matches</div>
          </div>
          <div className="kpi-cell">
            <div className="kpi-num">{formatRpow(stats.total_volume_base_units)}</div>
            <div className="kpi-label">RPOW wagered</div>
          </div>
          <div className="kpi-cell">
            <div className="kpi-num">{stats.open_arena_count}</div>
            <div className="kpi-label">in the arena</div>
          </div>
          <div className="kpi-cell">
            <div className="kpi-num">{stats.total_verified_users.toLocaleString()}</div>
            <div className="kpi-label">verified players</div>
          </div>
        </div>
      )}

      {authState === 'loading' && <p style={{ padding: '20px 24px' }}>loading...</p>}

      {authState === 'spectator' && (
        <div className="banner">
          You're spectating. <a href="https://rpow2.com/#/">Sign in at rpow2.com</a> to play.
        </div>
      )}

      {authState === 'unverified' && (
        <XHandleClaimModal onVerified={refreshAll} />
      )}

      <main>
        <section className="main-col lobby-panel">
          {authState === 'verified' && !myOpenSession && me && (
            <EnterArenaForm
              balanceBaseUnits={me.balance_base_units}
              onEntered={refreshAll}
            />
          )}
          {authState === 'verified' && myOpenSession && (
            <YourSessionPanel session={myOpenSession} onClosed={refreshAll} />
          )}

          <div className="panel-inner">
            <h2>OPEN PLAYERS ({lobby.length})</h2>
            {lobby.length === 0
              ? <p style={{ color: '#666' }}>nobody in the arena</p>
              : lobby.map(g => {
                  const isOwnSession = me && g.account_email === me.email;
                  return (
                    <div key={g.session_id} className="lobby-row">
                      <div>
                        <XLink handle={g.x_handle} />
                        {' — '}
                        bankroll {formatRpow(g.bankroll_remaining_base_units)} RPOW
                        {' — '}
                        bet {formatRpow(g.bet_base_units)} RPOW
                        {' — '}
                        W/L {g.matches_won}/{g.matches_lost}
                      </div>
                      {authState === 'verified' && !isOwnSession && (
                        <button onClick={() => setChallengeTarget(g)} style={{ marginLeft: 8 }}>
                          [ CHALLENGE ]
                        </button>
                      )}
                      {isOwnSession && (
                        <span style={{ marginLeft: 8, color: '#666', fontSize: 11 }}>(you)</span>
                      )}
                    </div>
                  );
                })
            }
          </div>

          <div className="panel-inner" style={{ marginTop: 24 }}>
            <h2>RECENT MATCHES</h2>
            {recent.length === 0
              ? <p style={{ color: '#666' }}>no matches yet</p>
              : recent.slice(0, 10).map(m => {
                  const winnerHandle = m.winner_email === m.offerer_email ? m.offerer_x_handle : m.challenger_x_handle;
                  const loserHandle = m.winner_email === m.offerer_email ? m.challenger_x_handle : m.offerer_x_handle;
                  const payout = (BigInt(m.bet_base_units) * 2n).toString();
                  return (
                    <div key={m.id} className="flip-row">
                      <XLink handle={winnerHandle} /> beat <XLink handle={loserHandle} /> for {formatRpow(payout)} RPOW
                    </div>
                  );
                })
            }
          </div>
        </section>

        <aside className="chat-panel">
          <h2>ARENA CHAT</h2>
          <div className="chat-scroll" ref={chatScrollRef}>
            {chat.length === 0
              ? <p style={{ color: '#666' }}>no messages yet</p>
              : [...chat].reverse().map(m => (
                  <div key={m.id} className={m.kind === 'SYSTEM' ? 'chat-system' : 'chat-user'}>
                    {m.kind === 'SYSTEM'
                      ? <em>{linkifyHandles(m.body)}</em>
                      : <><XLink handle={m.x_handle} />: {m.body}</>}
                  </div>
                ))
            }
          </div>
          {authState === 'verified' ? (
            <div className="chat-input-row">
              <input
                type="text"
                value={chatDraft}
                onChange={e => setChatDraft(e.target.value.slice(0, 280))}
                onKeyDown={e => { if (e.key === 'Enter') sendChat(); }}
                placeholder="say something..."
                maxLength={280}
                disabled={chatBusy}
              />
              <button onClick={sendChat} disabled={chatBusy || !chatDraft.trim()}>
                {chatBusy ? '...' : 'send'}
              </button>
            </div>
          ) : (
            <p style={{ fontSize: 11, color: '#666', marginTop: 8 }}>
              {authState === 'unverified'
                ? 'verify your X handle to chat'
                : 'sign in at rpow2.com to chat'}
            </p>
          )}
          {chatError && <div className="error" style={{ marginTop: 6, fontSize: 11 }}>{chatError}</div>}
        </aside>
      </main>

      {/* Challenger-side modal: opens when user clicks [CHALLENGE] on a lobby row. */}
      {challengeTarget && me && profile && (
        <TriviaMatchModal
          mode={{ kind: 'challenger', target: challengeTarget }}
          myEmail={me.email}
          onClose={() => { setChallengeTarget(null); refreshAll(); }}
        />
      )}

      {/* Offerer-side modal: opens automatically when /matches/active surfaces an in-flight match. */}
      {incomingMatchId && !challengeTarget && me && profile && (
        <TriviaMatchModal
          mode={{ kind: 'offerer', matchId: incomingMatchId }}
          myEmail={me.email}
          onClose={() => { setIncomingMatchId(null); refreshAll(); }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```
cd apps/web-trivia && npx tsc --noEmit
```

Expected: errors only about `TriviaMatchModal` (not yet implemented). Add a placeholder so tsc passes:

`apps/web-trivia/src/TriviaMatchModal.tsx`:

```tsx
interface ChallengerMode { kind: 'challenger'; target: { session_id: string; x_handle: string; bet_base_units: string } }
interface OffererMode { kind: 'offerer'; matchId: string }

interface Props {
  mode: ChallengerMode | OffererMode;
  myEmail: string;
  onClose: () => void;
}

export function TriviaMatchModal(_props: Props) {
  return null;
}
```

Now `npx tsc --noEmit` should pass cleanly.

- [ ] **Step 3: Commit**

```bash
git add apps/web-trivia/src/App.tsx apps/web-trivia/src/TriviaMatchModal.tsx
git commit -m "feat(trivia-web): App + lobby/chat/recent layout + offerer auto-poll"
```

---

## Task 4: TriviaMatchModal — countdown clock + result reveal

**Files:**
- Modify (replace placeholder): `apps/web-trivia/src/TriviaMatchModal.tsx`
- Modify: `apps/web-trivia/src/styles.css` (add a small block of trivia-specific classes; everything else inherits)

This is the heart of slice 5. Three visual states:

1. **loading** — POST `/matches/start` in flight (challenger mode only). Renders a 1-line "starting match…" skeleton.
2. **active** — full question + 4 large choice buttons labeled A/B/C/D + a countdown clock driven by `deadline_at - Date.now()`. Once a player picks: their button stays highlighted, the rest disable, replace with "waiting for opponent" indicator. Polls `/matches/:id` at 1s cadence to detect when state flips to RESOLVED.
3. **result** — winner banner (YOU WON / YOU LOST), the player's pick highlighted (green if correct, red if wrong), the opponent's pick shown side-by-side, the correct answer revealed with a `✓` marker, signature footer with truncated hex, and (if won) a `[ POST TO X ]` intent button.

The countdown clock uses `useEffect` + `setInterval(…, 100)` to tick smoothly. The displayed value is `Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000))`. When it hits 0, we keep polling — the backend lazy-resolves on the next poll.

- [ ] **Step 1: Replace TriviaMatchModal.tsx**

```tsx
import { useEffect, useRef, useState } from 'react';
import {
  startMatch, submitAnswer, fetchMatch, formatRpow,
  type MatchPollPayload, type LobbyEntry,
} from './api.js';

type ChallengerMode = { kind: 'challenger'; target: LobbyEntry };
type OffererMode    = { kind: 'offerer'; matchId: string };

interface Props {
  mode: ChallengerMode | OffererMode;
  myEmail: string;
  onClose: () => void;
}

type Stage = 'loading' | 'active' | 'result';

const POLL_MS = 1000;     // poll the match while in-flight
const TICK_MS = 100;      // countdown tick

const LETTERS = ['A', 'B', 'C', 'D'];

export function TriviaMatchModal({ mode, myEmail, onClose }: Props) {
  const [stage, setStage] = useState<Stage>(mode.kind === 'challenger' ? 'loading' : 'active');
  const [match, setMatch] = useState<MatchPollPayload | null>(null);
  const [myPickIdx, setMyPickIdx] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(Date.now());

  const matchIdRef = useRef<string | null>(null);

  // --- Initial fetch / start --------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (mode.kind === 'challenger') {
          const start = await startMatch(mode.target.session_id);
          if (cancelled) return;
          // Fetch the canonical poll payload — we want the same shape for both modes.
          matchIdRef.current = start.match_id;
          const m = await fetchMatch(start.match_id);
          if (cancelled) return;
          if (m) {
            setMatch(m);
            setStage(m.state === 'RESOLVED' ? 'result' : 'active');
          }
        } else {
          matchIdRef.current = mode.matchId;
          const m = await fetchMatch(mode.matchId);
          if (cancelled) return;
          if (m) {
            setMatch(m);
            setStage(m.state === 'RESOLVED' ? 'result' : 'active');
          }
        }
      } catch (e: any) {
        setStartError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [mode.kind, mode.kind === 'challenger' ? mode.target.session_id : mode.matchId]);

  // --- Countdown tick --------------------------------------------------------
  useEffect(() => {
    if (stage !== 'active') return;
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [stage]);

  // --- Match poll while ACTIVE -----------------------------------------------
  useEffect(() => {
    if (stage !== 'active' || !matchIdRef.current) return;
    const id = matchIdRef.current;
    const t = setInterval(async () => {
      const m = await fetchMatch(id).catch(() => null);
      if (!m) return;
      setMatch(m);
      if (m.state === 'RESOLVED') setStage('result');
    }, POLL_MS);
    return () => clearInterval(t);
  }, [stage]);

  // --- Auto-flip to result when our local timer hits 0 AND poll confirms ----
  // The backend lazy-resolves on the next poll once deadline_at passes; the
  // poll above will pick it up. No client-side resolution needed.

  // --- Helpers ---------------------------------------------------------------
  function secondsLeft(): number {
    if (!match) return 0;
    const ms = new Date(match.deadline_at).getTime() - now;
    return Math.max(0, Math.ceil(ms / 1000));
  }

  async function pick(idx: number) {
    if (!match || myPickIdx !== null || submitting) return;
    setSubmitting(true);
    setMyPickIdx(idx);
    try {
      await submitAnswer(match.id, idx);
      // Immediately re-poll so we either see RESOLVED (if both have answered)
      // or just an updated "you've answered" state.
      const m = await fetchMatch(match.id).catch(() => null);
      if (m) {
        setMatch(m);
        if (m.state === 'RESOLVED') setStage('result');
      }
    } catch (e: any) {
      setStartError(e.message);
      setMyPickIdx(null);
    } finally {
      setSubmitting(false);
    }
  }

  // --- Render ----------------------------------------------------------------

  if (stage === 'loading') {
    return (
      <div className="modal-backdrop">
        <div className="modal">
          <h2>STARTING MATCH…</h2>
          {startError && <div className="error" style={{ marginTop: 8 }}>{startError}</div>}
          {startError && (
            <button onClick={onClose} style={{ marginTop: 12 }}>close</button>
          )}
        </div>
      </div>
    );
  }

  if (!match) {
    return (
      <div className="modal-backdrop">
        <div className="modal">
          <h2>LOADING MATCH…</h2>
          {startError && <div className="error" style={{ marginTop: 8 }}>{startError}</div>}
          {startError && (
            <button onClick={onClose} style={{ marginTop: 12 }}>close</button>
          )}
        </div>
      </div>
    );
  }

  const iAmOfferer = match.offerer_email === myEmail;
  const myAnswered = iAmOfferer ? match.offerer_answered : match.challenger_answered;
  const oppAnswered = iAmOfferer ? match.challenger_answered : match.offerer_answered;
  const oppHandle = iAmOfferer ? match.challenger_x_handle : match.offerer_x_handle;

  if (stage === 'active') {
    const remaining = secondsLeft();
    const myPickDisplayed = myPickIdx ?? (myAnswered ? -1 : null);
    return (
      <div className="modal-backdrop">
        <div className="modal trivia-active">
          <div className="trivia-meta">
            <span>vs <a href={`https://x.com/${oppHandle}`} target="_blank" rel="noreferrer noopener" className="x-handle">@{oppHandle}</a></span>
            <span className="trivia-stake">stake {formatRpow(match.bet_base_units)} RPOW</span>
            <span className={`trivia-clock ${remaining <= 3 ? 'urgent' : ''}`}>{remaining}s</span>
          </div>
          <h2 className="trivia-question">{match.question}</h2>
          <div className="trivia-choices">
            {match.choices.map((c, i) => {
              const isMine = myPickDisplayed === i;
              const cls = ['trivia-choice', isMine ? 'picked' : '', myPickDisplayed !== null && !isMine ? 'dim' : ''].join(' ').trim();
              return (
                <button
                  key={i}
                  className={cls}
                  disabled={myPickDisplayed !== null || submitting || remaining === 0}
                  onClick={() => pick(i)}
                >
                  <span className="trivia-letter">{LETTERS[i]}</span>
                  <span className="trivia-choice-text">{c}</span>
                </button>
              );
            })}
          </div>
          <div className="trivia-status">
            {myAnswered && !oppAnswered && `waiting for @${oppHandle}…`}
            {!myAnswered && oppAnswered && `@${oppHandle} has answered. your turn.`}
            {myAnswered && oppAnswered && 'resolving…'}
            {!myAnswered && !oppAnswered && remaining === 0 && 'time up — resolving…'}
          </div>
          {startError && <div className="error" style={{ marginTop: 8 }}>{startError}</div>}
        </div>
      </div>
    );
  }

  // stage === 'result'
  const iWon = match.winner_email === myEmail;
  const payout = formatRpow((BigInt(match.bet_base_units) * 2n).toString());
  const correctIdx = match.correct_choice_idx;
  const myIdx = iAmOfferer ? match.offerer_choice_idx : match.challenger_choice_idx;
  const oppIdx = iAmOfferer ? match.challenger_choice_idx : match.offerer_choice_idx;
  const shareText = iWon && oppHandle
    ? `I just won ${payout} RPOW in the RPOW Trivia arena against @${oppHandle} by answering "${match.question.length > 80 ? match.question.slice(0, 77) + '…' : match.question}" correctly. Come fight me at trivia.rpow2.com`
    : '';
  const tweetHref = shareText
    ? `https://x.com/intent/post?text=${encodeURIComponent(shareText)}`
    : '';

  return (
    <div className="modal-backdrop">
      <div className={`modal trivia-result ${iWon ? 'trivia-win' : 'trivia-lose'}`}>
        <h2 style={{ color: iWon ? 'var(--accent)' : '#e07a7a', marginTop: 0 }}>
          {iWon ? `YOU WON ${payout} RPOW` : `YOU LOST ${formatRpow(match.bet_base_units)} RPOW`}
        </h2>
        <p className="trivia-question" style={{ fontSize: 14, fontStyle: 'italic' }}>
          “{match.question}”
        </p>
        <div className="trivia-result-grid">
          {match.choices.map((c, i) => {
            const isCorrect = i === correctIdx;
            const isMyPick = i === myIdx;
            const isOppPick = i === oppIdx;
            const cls = [
              'trivia-result-row',
              isCorrect ? 'correct' : '',
              isMyPick ? 'mine' : '',
              isOppPick ? 'opponent' : '',
            ].join(' ').trim();
            return (
              <div key={i} className={cls}>
                <span className="trivia-letter">{LETTERS[i]}</span>
                <span className="trivia-choice-text">{c}</span>
                <span className="trivia-markers">
                  {isCorrect && <span title="correct answer">✓</span>}
                  {isMyPick && <span title="your pick">you</span>}
                  {isOppPick && <span title="opponent's pick">@{oppHandle}</span>}
                </span>
              </div>
            );
          })}
        </div>
        {match.signature_hex && (
          <div style={{ marginTop: 12, fontSize: 11, color: '#666' }}>
            sig: {match.signature_hex.slice(0, 16)}… · resolved {match.resolved_at && new Date(match.resolved_at).toLocaleTimeString()}
          </div>
        )}
        {iWon && tweetHref && (
          <a
            href={tweetHref}
            target="_blank"
            rel="noreferrer"
            style={{ display: 'inline-block', marginTop: 16 }}
          >
            [ POST TO X ]
          </a>
        )}
        <button onClick={onClose} style={{ marginTop: 16, display: 'block' }}>
          close
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add trivia-specific styles**

Append to `apps/web-trivia/src/styles.css`:

```css
/* === Trivia match modal === */

.trivia-active, .trivia-result {
  min-width: 480px;
  max-width: 640px;
}

.trivia-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--dim);
  margin-bottom: 12px;
  gap: 12px;
}

.trivia-stake { color: var(--fg); }

.trivia-clock {
  font-size: 28px;
  font-weight: 700;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
  min-width: 3ch;
  text-align: right;
}
.trivia-clock.urgent { color: var(--warn); animation: pulse 600ms ease-in-out infinite alternate; }
@keyframes pulse { from { opacity: 0.65; } to { opacity: 1; } }

.trivia-question {
  font-size: 16px;
  line-height: 1.4;
  margin: 8px 0 16px;
  color: var(--fg);
}

.trivia-choices {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 12px;
}

.trivia-choice {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--accent-dim);
  background: rgba(110,231,183,0.02);
  color: var(--fg);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: all 120ms;
  min-height: 60px;
}
.trivia-choice:hover:not(:disabled) {
  border-color: var(--accent);
  background: rgba(110,231,183,0.06);
}
.trivia-choice:disabled { cursor: not-allowed; }
.trivia-choice.picked {
  border-color: var(--accent);
  background: var(--accent-dim);
  color: var(--accent);
}
.trivia-choice.dim { opacity: 0.4; }

.trivia-letter {
  display: inline-block;
  width: 22px;
  height: 22px;
  line-height: 22px;
  text-align: center;
  border: 1px solid var(--accent-dim);
  color: var(--accent);
  font-weight: 600;
  flex-shrink: 0;
}

.trivia-choice-text { flex: 1; }

.trivia-status {
  font-size: 12px;
  color: var(--dim);
  text-align: center;
  margin-top: 8px;
  min-height: 16px;
}

/* === Result grid === */
.trivia-result-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0;
}
.trivia-result-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--dimmer);
  font-size: 13px;
}
.trivia-result-row.correct {
  border-color: var(--accent);
  background: rgba(110,231,183,0.06);
}
.trivia-result-row.mine.correct { color: var(--accent); }
.trivia-result-row.mine:not(.correct) { color: var(--warn); border-color: var(--warn); }
.trivia-markers {
  margin-left: auto;
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--dim);
}
.trivia-markers > span { padding: 2px 6px; border: 1px solid var(--dimmer); }
```

- [ ] **Step 3: Typecheck + dev server smoke**

```
cd apps/web-trivia && npx tsc --noEmit
```

Expected: clean.

Start the dev server (background-run it from the workspace root):

```
cd /Users/fredkrueger/rpow && npm run dev --workspace @rpow/web-trivia &
```

Visit `http://localhost:5176`. Smoke-check:
- Page loads, header shows "RPOW TRIVIA"
- Spectator banner appears (you're not logged in by default)
- KPI strip shows live numbers from the prod API
- Lobby panel renders (empty or populated)
- Chat panel renders
- No JS errors in browser console

Then kill the dev server. Don't commit the test artifacts.

- [ ] **Step 4: Commit**

```bash
git add apps/web-trivia/src/TriviaMatchModal.tsx apps/web-trivia/src/styles.css
git commit -m "feat(trivia-web): TriviaMatchModal — countdown + result reveal"
```

---

## Task 5: Workspaces registration + final build

**Files:**
- Modify: `package.json` (repo root) — add `apps/web-trivia` to `workspaces` array if needed
- Verify: full repo `npm install` succeeds, `npm run build --workspace @rpow/web-trivia` succeeds

- [ ] **Step 1: Inspect workspaces array**

```
cat /Users/fredkrueger/rpow/package.json
```

If `workspaces` is `["apps/*"]` (a glob), no change needed. If it's an explicit list, add `"apps/web-trivia"` to it.

- [ ] **Step 2: Install + build**

```
cd /Users/fredkrueger/rpow && npm install
cd apps/web-trivia && npm run build
```

Expected: `vite build` produces `dist/` artifacts (index.html + JS bundle). No errors.

- [ ] **Step 3: Commit (if package.json changed)**

If the root `package.json` needed an edit:

```bash
git add package.json
git commit -m "build: register apps/web-trivia in workspaces"
```

If not, skip this step.

---

## Self-Review

**Spec coverage check (vs §8 of the design):**

| Spec requirement | Implemented in |
|---|---|
| Three top-level states (spectator / unverified / verified) | Task 3 (App.tsx authState) |
| Header + KPI strip | Task 3 |
| EnterArenaForm | Task 2 |
| YourSessionPanel (with auto-watch for incoming match) | Task 2 (panel) + Task 3 (offerer auto-poll) |
| TriviaMatchModal — loading / active / result states | Task 4 |
| Countdown driven by deadline_at | Task 4 (`secondsLeft()` + 100ms ticker) |
| KPIStrip — total matches, RPOW wagered, in arena, verified players | Task 3 |
| ArenaChat with input + auto-scroll | Task 3 (chatScrollRef) |
| RecentMatchesPanel — "X beat Y for Z RPOW" | Task 3 |
| Polling 5s lobby/chat/recent | Task 3 |
| Polling 2s /matches/active | Task 3 |
| Polling 1s /matches/:id while in match | Task 4 |
| Forwarded-session adoption | Task 1 (main.tsx) |
| Share-on-X intent on win | Task 4 |
| correct_choice_idx hidden until RESOLVED | Server enforces it; frontend just renders what's there |

**No placeholders.** All code is complete inline.

**Type consistency.** `MatchPollPayload`, `LobbyEntry`, `TriviaStats`, etc. defined in Task 1 are used unchanged in Tasks 3 and 4.

**Slice scope.** Pure frontend. The deploy work (Netlify site + Cloudflare DNS for trivia.rpow2.com) is slice 6 — Task 1 includes the `netlify.toml` so it's ready, but no deploy is performed in this slice.
