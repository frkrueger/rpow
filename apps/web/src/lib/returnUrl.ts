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
