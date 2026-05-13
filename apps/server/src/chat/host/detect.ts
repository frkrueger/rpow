/** @-mention detection for the AI host.
 *
 *  The host responds when a user's message addresses it by name. Match
 *  is liberal: case-insensitive, the host's first word OR full name,
 *  preceded by `@` and a word boundary. Also matches the canonical
 *  `@<slug>.host` form for power users.
 *
 *  Examples for host_name='Hal Finney' in room 'rpow':
 *    "@Hal what's the story" → match
 *    "@hal finney any thoughts" → match
 *    "@rpow.host?" → match
 *    "hal said it well" → no match (no @ prefix)
 *    "halfway there" → no match (boundary)
 */

export function mentionsHost(body: string, hostName: string, roomSlug: string): boolean {
  if (!body) return false;
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Universal alias: @Host (and the per-room @<slug>.host form) ALWAYS
  // trigger, regardless of the host's persona name. This is the safe,
  // discoverable way to call the host since the persona names differ
  // per room.
  const universal = /(^|\W)@host(?![\w])/i;
  if (universal.test(body)) return true;

  const slugMention = `@${roomSlug.toLowerCase()}.host`;
  if (body.toLowerCase().includes(slugMention)) return true;

  // Persona name: @<firstWord> OR @<full name>, case-insensitive, word-boundary.
  const fullName = hostName.toLowerCase();
  const firstWord = fullName.split(/\s+/)[0] ?? '';
  if (firstWord) {
    const re = new RegExp(`(^|\\W)@${escapeRe(firstWord)}(?![\\w])`, 'i');
    if (re.test(body)) return true;
  }
  if (fullName !== firstWord) {
    const re = new RegExp(`(^|\\W)@${escapeRe(fullName)}(?![\\w])`, 'i');
    if (re.test(body)) return true;
  }
  return false;
}
