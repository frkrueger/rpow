// SRPOW wrap eligibility. Configured via the WRAP_ALLOWED_EMAILS env var:
//
//   ""                    → no one (default; safe — wrap is opt-in)
//   "alice@x,bob@y"       → CSV allowlist of exact email addresses
//   "*"                   → allow ALL authenticated users
//
// The CSV path stays for selective rollouts and debug environments; the
// wildcard form is the public-launch switch.

export type WrapAllowlist =
  | { kind: 'all' }
  | { kind: 'list'; emails: Set<string> };

export function parseAllowlist(csv: string): WrapAllowlist {
  const trimmed = (csv ?? '').trim();
  if (trimmed === '*') return { kind: 'all' };
  return {
    kind: 'list',
    emails: new Set(
      trimmed
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  };
}

export function isAllowed(allowlist: WrapAllowlist, email: string): boolean {
  if (allowlist.kind === 'all') return true;
  return allowlist.emails.has(email.trim().toLowerCase());
}
