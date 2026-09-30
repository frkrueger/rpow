/**
 * X (Twitter) handle verification helpers.
 *
 * normalizeHandle — strips "@", lowercases, validates Twitter handle rules.
 * verifyTweet    — calls publish.twitter.com/oembed and extracts author + body.
 */

// Twitter handles: 1-15 chars, alphanumeric + underscore only.
const HANDLE_RE = /^[a-z0-9_]{1,15}$/;
// Valid tweet URL patterns.
const TWEET_URL_RE = /^https:\/\/(twitter\.com|x\.com)\/[A-Za-z0-9_]{1,15}\/status\/\d+/;

export function normalizeHandle(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  // Strip leading @
  const stripped = raw.startsWith('@') ? raw.slice(1) : raw;
  // Reject if empty or contains any non-ASCII character or whitespace
  if (!stripped || /[^\x00-\x7F]/.test(stripped) || /\s/.test(stripped)) return null;
  const lower = stripped.toLowerCase();
  if (!HANDLE_RE.test(lower)) return null;
  return lower;
}

export interface OEmbedResult {
  authorHandle: string; // lowercase, no @
  text: string;         // tweet body, HTML stripped
}

function stripHtml(html: string): string {
  // Remove all HTML tags
  let s = html.replace(/<[^>]*>/g, '');
  // Decode common entities
  s = s.replace(/&quot;/g, '"');
  s = s.replace(/&amp;/g, '&');
  s = s.replace(/&#39;/g, "'");
  s = s.replace(/&lt;/g, '<');
  s = s.replace(/&gt;/g, '>');
  s = s.replace(/&nbsp;/g, ' ');
  return s;
}

function extractHandle(authorUrl: string): string | null {
  // author_url is like https://twitter.com/SomeUser or https://x.com/SomeUser
  try {
    const url = new URL(authorUrl);
    const path = url.pathname; // e.g. /SomeUser
    const parts = path.split('/').filter(Boolean);
    if (parts.length < 1) return null;
    return parts[0].toLowerCase();
  } catch {
    return null;
  }
}

async function attemptFetch(tweetUrl: string): Promise<OEmbedResult | null> {
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}&omit_script=1`;
  const res = await fetch(oembedUrl, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return null;
  let json: { author_url?: string; html?: string };
  try {
    json = await res.json() as { author_url?: string; html?: string };
  } catch {
    return null;
  }
  if (!json.author_url || !json.html) return null;
  const authorHandle = extractHandle(json.author_url);
  if (!authorHandle) return null;
  const text = stripHtml(json.html);
  return { authorHandle, text };
}

export async function verifyTweet(tweetUrl: string): Promise<OEmbedResult | null> {
  // Validate the URL looks like a real tweet URL before fetching
  if (!TWEET_URL_RE.test(tweetUrl)) return null;

  // First attempt
  try {
    const result = await attemptFetch(tweetUrl);
    if (result !== null) return result;
  } catch {
    // Fall through to retry on transient failure (timeout, network error)
  }

  // One retry on transient failure
  try {
    return await attemptFetch(tweetUrl);
  } catch {
    return null;
  }
}
