// Disposable / bot-farm email domains we refuse to issue magic links to.
//
// Curated by analyzing the users table during the May-2026 bot wave (see
// scripts/email-analysis/classify.py). Anything here had thousands of
// near-identical signups in a short window and zero legitimate user
// signal; rejecting at /auth/request prevents the next wave from even
// creating accounts.
//
// Conservative by design: we only blocklist domains where we've confirmed
// abuse at scale. Common provider domains where bots and real users mix
// (gmail.com, yahoo.com, qq.com, rambler.ru) are NOT blocked here —
// per-account/per-IP rate limits handle them.
//
// To update: append the offender, redeploy. No DB write — restart-safe.

const BLOCKED_DOMAINS: ReadonlySet<string> = new Set([
  // Bot-farm domains observed with thousands of near-identical signups
  // during the May-2026 wave (most have generic alphanumeric usernames,
  // no real user activity, no real-looking referer trails).
  'wshu.net',
  'issue0x.com',
  'raleigh-construction.com',
  'teihu.com',
  'questtechsystems.com',
  'oakon.com',
  'pastryofistanbul.com',
  'zyper.app',
  'mymails.email',
  'smail.pw',
  'dddhuas.com',
  'rpowsaya.xyz',
  'computex.work',
  'tambatamsau.com',
  'shibax.codes',
  'oxkage.biz.id',

  // Well-known temporary/disposable email providers. Real users do not
  // sign up to a service they care about with a 10-minute mailbox.
  'mailinator.com',
  'tempmail.com',
  '10minutemail.com',
  'guerrillamail.com',
  'yopmail.com',
  'throwawaymail.com',
  'sharklasers.com',
  'getnada.com',
  'maildrop.cc',
  'tempr.email',
  'tempinbox.com',
  'fakemailgenerator.com',
  'mohmal.com',
  'spambog.com',
  'mailnesia.com',
  'discard.email',
  'dispostable.com',
  'emailondeck.com',
  'fakeinbox.com',
  'mintemail.com',
  'trashmail.com',
]);

/** Returns true if the email's domain is in the disposable blocklist.
 *  Case-insensitive; matches the domain exactly (no wildcard), since most
 *  bot operators use the apex domain. */
export function isDisposableEmail(email: string): boolean {
  const at = email.indexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase().trim();
  return BLOCKED_DOMAINS.has(domain);
}

/** Providers that treat `user+tag@domain` as the same inbox as `user@domain`.
 *  Bots exploit this by fanning out hundreds of +tags off one real inbox to
 *  create many "different" accounts. Normalizing strips the +tag so the dupes
 *  collide on the unique constraint. */
const PLUS_ADDRESSING_PROVIDERS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com',
]);

/** Lowercase + trim + strip Gmail-style +tags. Used as the canonical signup
 *  identity. We do NOT strip dots in the gmail local-part (also ignored by
 *  Gmail) because the existing user base has many dotted variants already. */
export function normalizeEmail(email: string): string {
  const trimmed = email.toLowerCase().trim();
  const at = trimmed.indexOf('@');
  if (at < 0) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!PLUS_ADDRESSING_PROVIDERS.has(domain)) return trimmed;
  const plus = local.indexOf('+');
  if (plus < 0) return trimmed;
  return local.slice(0, plus) + '@' + domain;
}

/** Exposed for tests + admin views. */
export { BLOCKED_DOMAINS };
