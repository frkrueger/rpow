import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type ChatMessage, type Me } from './api.js';
import { useRoomStream } from './RealtimeProvider.js';

interface Props {
  me: Me | null;
}

/** Scrollback + composer for a single room. Joins the realtime stream
 *  for live updates. Auth states: anon → CTA, signed but no x_handle →
 *  bind CTA, signed+verified → enabled composer. */
export function RoomView({ me }: Props) {
  const { slug } = useParams<{ slug: string }>();
  const room = slug ?? 'general';
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Cold scrollback fetch on room change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.scrollback(room, 50)
      .then(r => {
        if (cancelled) return;
        setMessages(r.messages.map(m => ({
          id: m.id,
          room: m.roomSlug,
          x_handle: m.xHandle,
          avatar: m.xAvatarUrl,
          body: m.body,
          at: m.createdAt,
          is_host: m.isHost,
        })));
        setLoading(false);
      })
      .catch(e => {
        if (cancelled) return;
        setError(e.message ?? String(e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [room]);

  // Live updates.
  const handleEvent = useCallback((evt: import('./RealtimeProvider.js').RealtimeEvent) => {
    if (evt.type === 'message') {
      // De-dupe: optimistic posts get the same id back from POST.
      setMessages(prev => prev.some(m => m.id === evt.message.id) ? prev : [...prev, evt.message]);
    } else if (evt.type === 'message_deleted') {
      setMessages(prev => prev.filter(m => m.id !== evt.id));
    }
  }, []);
  useRoomStream(room, handleEvent);

  // Stick to bottom on new messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const composerState = useMemo<'anon' | 'no_handle' | 'ready'>(() => {
    if (!me) return 'anon';
    if (!me.x_handle) return 'no_handle';
    return 'ready';
  }, [me]);

  async function onSend(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const body = draft.trim();
    if (!body || composerState !== 'ready' || sending) return;
    setSending(true);
    setError(null);
    try {
      const sent = await api.postMessage(room, body);
      setMessages(prev => prev.some(m => m.id === sent.id) ? prev : [...prev, sent]);
      setDraft('');
    } catch (e: unknown) {
      const err = e as { message?: string; code?: string; status?: number };
      if (err.code === 'RATE_LIMITED') {
        setError('Slow down — sending too fast.');
      } else if (err.status === 403 && err.code === 'BANNED') {
        setError('You are banned from posting.');
      } else if (err.code === 'LANGUAGE_MISMATCH') {
        setError(err.message ?? 'Wrong language for this room.');
      } else if (err.status === 404) {
        setError('This room no longer exists.');
      } else {
        setError(err.message ?? 'Failed to send.');
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="section room-view">
      <div className="section-head">
        <h2 className="section-title">#{room}</h2>
        <p className="section-sub">{loading ? '…' : `${messages.length} message${messages.length === 1 ? '' : 's'}`}</p>
      </div>

      <div className="room-scrollback" ref={scrollRef}>
        {loading && <div className="room-loading">Loading…</div>}
        {!loading && messages.length === 0 && (
          <div className="room-empty">
            <span className="empty-glyph">no messages yet</span>
            <p>Be the first to post in #{room}.</p>
          </div>
        )}
        {!loading && messages.map(m => (
          <div className={`msg${m.is_host ? ' is-host' : ''}`} key={m.id}>
            {m.is_host
              ? <span className="msg-avatar host-glyph" aria-hidden="true">🅷</span>
              : m.avatar
                ? <img className="msg-avatar" src={m.avatar} alt={`@${m.x_handle}`} loading="lazy" />
                : <span className="msg-avatar placeholder" aria-hidden="true">{m.x_handle.slice(0, 1).toUpperCase()}</span>
            }
            <div className="msg-body">
              {m.is_host
                ? <span className="msg-handle host-handle">{m.x_handle} <span className="host-badge">[host]</span></span>
                : <a className="msg-handle" href={`https://x.com/${m.x_handle}`} target="_blank" rel="noreferrer">@{m.x_handle}</a>
              }
              <span className="msg-text">{m.body}</span>
            </div>
          </div>
        ))}
      </div>

      {composerState === 'anon' && (
        <div className="composer-cta">
          <p>Sign in with rpow + verify your X handle to post.</p>
          <a className="cta-primary" href="https://rpow2.com" style={{ display: 'inline-flex', width: 'auto' }}>
            <span>Sign in at rpow2.com</span><span className="arrow">→</span>
          </a>
        </div>
      )}
      {composerState === 'no_handle' && (
        <div className="composer-cta">
          <p>Link your X account on rpow2.com to post.</p>
          <a className="cta-primary" href="https://rpow2.com" style={{ display: 'inline-flex', width: 'auto' }}>
            <span>Link X on rpow2.com</span><span className="arrow">→</span>
          </a>
        </div>
      )}
      {composerState === 'ready' && (
        <form className="composer" onSubmit={onSend}>
          <input
            type="text"
            placeholder={`Say something in #${room}…`}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            disabled={sending}
            maxLength={2000}
          />
          <button type="submit" disabled={sending || draft.trim().length === 0}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
