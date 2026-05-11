/**
 * Shared allowlist + terms-acceptance helpers for /amm/* endpoints.
 *
 * Every AMM endpoint (this slice and all subsequent ones) MUST run:
 *   1. `assertAmmAllowed(app, email)` — checks AMM_ALLOWED_EMAILS allowlist.
 *   2. `assertTermsAccepted(app, email)` — confirms the user clicked through
 *      the experimental-game warning.
 *
 * Admin endpoints additionally check `isAmmAdmin`.
 *
 * Allowlist matching is case-insensitive; '*' opens the gate to all users.
 */

import type { FastifyInstance } from 'fastify';

/** CSV allowlist check. '*' means everyone is allowed. Case-insensitive. */
export function isAllowed(allowlistCsv: string, email: string): boolean {
  const trimmed = allowlistCsv.trim();
  if (trimmed === '*') return true;
  const emailLower = email.toLowerCase();
  return trimmed
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(emailLower);
}

/** True iff caller is in the AMM admin allowlist. Admin allowlist defaults to
 *  empty (no admins) — must be explicitly configured. '*' is intentionally NOT
 *  accepted here; we never want "everyone is an admin". */
export function isAmmAdmin(app: FastifyInstance, email: string): boolean {
  const csv = app.config.ammAdminEmails.trim();
  if (!csv || csv === '*') return false;
  const emailLower = email.toLowerCase();
  return csv
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(emailLower);
}

/** Returns the row if accepted, null if not. */
export async function readTermsAcceptedAt(
  app: FastifyInstance,
  email: string,
): Promise<Date | null> {
  const res = await app.pool.query<{ amm_terms_accepted_at: Date | null }>(
    `SELECT amm_terms_accepted_at FROM users WHERE email = $1`,
    [email],
  );
  return res.rows[0]?.amm_terms_accepted_at ?? null;
}
