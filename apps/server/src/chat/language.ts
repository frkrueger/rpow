/** Pre-AI-host language stopgap.
 *
 *  Rejects messages whose script doesn't match the room's `language`
 *  setting. The check is conservative — it lets through anything that
 *  could plausibly be in the room's language (URLs, emoji, numbers,
 *  short proper nouns). It catches the obvious cases:
 *    - English rooms with CJK characters anywhere → reject
 *    - Mandarin rooms with only Latin letters (no CJK at all) → reject
 *  Slice 3's AI host will replace this with an LLM-judged check that
 *  understands code blocks, technical proper nouns, etc.
 */

// CJK Unified Ideographs + Compatibility — covers ~all Mandarin, plus
// Japanese kanji / Korean hanja. Good enough for the en/zh split.
const CJK_RE = /[㐀-鿿豈-﫿]/;
const LATIN_LETTER_RE = /[A-Za-z]/;

export type LanguageCheck = { ok: true } | { ok: false; reason: string };

export function validateLanguage(body: string, roomLanguage: string): LanguageCheck {
  if (roomLanguage === 'en') {
    if (CJK_RE.test(body)) {
      return { ok: false, reason: 'This room is English-only. Try one of the #中文-* rooms for Mandarin.' };
    }
    return { ok: true };
  }
  if (roomLanguage === 'zh') {
    // Allow if body has any CJK character. Reject only when there's Latin
    // letters present AND no CJK — a clear English-only post.
    if (!CJK_RE.test(body) && LATIN_LETTER_RE.test(body)) {
      return { ok: false, reason: 'This room is Mandarin-only. 请用中文发言。Try #general for English.' };
    }
    return { ok: true };
  }
  // Unknown language code — don't block. Slice 3+ can tighten.
  return { ok: true };
}
