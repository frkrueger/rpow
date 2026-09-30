import Anthropic from '@anthropic-ai/sdk';

/** Thin wrapper around the Anthropic SDK for chat-host turns.
 *
 *  - Model: claude-haiku-4-5 (fast + cheap; ~$0.0008 per turn at our token
 *    budget). Aggressive prompt caching on the system block keeps repeat
 *    turns from re-paying for the persona setup.
 *  - max_tokens: 300. Hosts are conversational — long replies feel out of
 *    place in a chat scroll.
 *  - We don't surface tool use here yet (mute / tip arrive in slice 3c).
 */

const MODEL = 'claude-haiku-4-5';
// Hosts should keep conversation moving without dominating it. Cap hard so
// replies stay one short sentence — never paragraphs.
const MAX_TOKENS = 60;

export type HostMode = 'reply' | 'idle';

export interface HostTurnArgs {
  apiKey: string;
  /** Persona blurb stored on the room. Becomes the cacheable system prompt. */
  persona: string;
  /** Room language code ('en' or 'zh' today) — passed into the system prompt. */
  language: string;
  /** The host's display name (e.g. 'Hal Finney'). */
  hostName: string;
  /** The room slug (for context — the host knows where it lives). */
  roomSlug: string;
  /** Recent room context, oldest-first. The triggering message is last. */
  recentMessages: Array<{ x_handle: string; body: string; is_host: boolean }>;
  /** 'reply' = respond to the most recent message (on @-mention).
   *  'idle'  = room has been quiet; post a thread-starter / follow-up. */
  mode: HostMode;
}

export async function runHostTurn(args: HostTurnArgs): Promise<string | null> {
  const client = new Anthropic({ apiKey: args.apiKey });

  const langLabel = args.language === 'zh' ? 'Mandarin Chinese' : 'English';
  const modeInstruction = args.mode === 'reply'
    ? `Reply to the most recent message in ONE short sentence. No preamble. No "great question". Just the substantive reply.`
    : `Room has been quiet. Post ONE short question or observation to nudge conversation. No greeting, no preamble.`;
  const systemPrompt = [
    `You are ${args.hostName}, the AI host of the rpow2 chatroom #${args.roomSlug}.`,
    `This room is ${langLabel}-only — write in ${langLabel}.`,
    ``,
    `Persona (for tone only, do not quote): ${args.persona}`,
    ``,
    `HARD STYLE RULES:`,
    `  • Exactly ONE sentence. ~120 characters max. Never paragraphs.`,
    `  • No "welcome!", no "great question", no "happy to chat", no sign-offs.`,
    `  • No bullet points. No multi-clause replies stacked with semicolons.`,
    `  • If someone says hi, reply with a brief question — not a welcome speech.`,
    `  • You are a quiet guide, not a participant. Users should do most of the talking.`,
    ``,
    `You are NOT the real ${args.hostName}; if pressed, say "I'm an AI host inspired by ${args.hostName}." (still one sentence).`,
    ``,
    `LANGUAGE: This room is ${langLabel}-only. If the most recent user message is in a different language, your one-sentence reply gently says (in ${langLabel}) that this is the ${langLabel} room and points them to the right room. Do NOT translate or engage on the off-topic content.`,
    ``,
    `RPOW tips: mention them ONLY when (a) the room is genuinely empty and you're the first post, or (b) someone explicitly asks how the room works. Otherwise, never bring tips up. Don't mention them in casual replies.`,
    ``,
    modeInstruction,
  ].join('\n');

  // The recent room messages become the conversational context. Re-shape
  // them into the user/assistant turns Anthropic expects. User-authored
  // messages are 'user' turns; prior host messages are 'assistant' turns.
  // Adjacent same-role turns get merged (the API requires alternation).
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of args.recentMessages) {
    const role: 'user' | 'assistant' = m.is_host ? 'assistant' : 'user';
    const content = m.is_host ? m.body : `@${m.x_handle}: ${m.body}`;
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.content += `\n${content}`;
    } else {
      turns.push({ role, content });
    }
  }
  // The API requires the first message to be 'user' — synthesize one if
  // the room scrollback opened with a host message.
  if (turns.length === 0 || turns[0]!.role !== 'user') {
    turns.unshift({ role: 'user', content: '(start of conversation)' });
  }
  // And it must END with a 'user' turn (we're requesting an assistant reply).
  if (turns[turns.length - 1]!.role !== 'user') {
    const promptSuffix = args.mode === 'idle'
      ? '(the room is quiet — post a brief thread-starter)'
      : '(continue the conversation)';
    turns.push({ role: 'user', content: promptSuffix });
  } else if (args.mode === 'idle') {
    // Even with messages present, idle mode wants the host to start a new
    // sub-thread rather than reply 1:1. Append an explicit cue.
    turns.push({ role: 'user', content: '(several minutes have passed — post a brief follow-up to keep the conversation alive)' });
  }

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        // cache_control on the system block — same persona every turn for
        // this room hits the cache.
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      messages: turns,
    });
    const block = res.content.find(b => b.type === 'text');
    if (!block || block.type !== 'text') return null;
    const text = block.text.trim();
    return text || null;
  } catch (e) {
    // Surfaced as a host that just doesn't reply this turn. Logged for ops.
    // eslint-disable-next-line no-console
    console.error('[chat/host] llm error:', e);
    return null;
  }
}
