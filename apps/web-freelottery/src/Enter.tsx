import { ReactNode, useEffect, useState } from 'react';
import { api, Me, StartResponse, VerifyResponse } from './api.js';
import { XHandleClaimModal } from './XHandleClaimModal.js';

function EnterShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bulletin">
      <header className="masthead">
        <span className="brand"><span className="dot" />RPOW · FREE LOTTERY</span>
        <span className="meta">ENTER · DRAW DAILY 19:00 UTC</span>
      </header>
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">{title}</h2>
        </div>
        <div className="enter-body">{children}</div>
      </section>
    </div>
  );
}

type View =
  | { stage: 'loading' }
  | { stage: 'login_required' }
  | { stage: 'bind_required'; me: Me }
  | { stage: 'already_entered'; me: Me }
  | { stage: 'ready_to_tweet'; me: Me; start: StartResponse }
  | { stage: 'verifying'; me: Me; start: StartResponse }
  | { stage: 'done'; me: Me; result: VerifyResponse };

export function Enter() {
  const [view, setView] = useState<View>({ stage: 'loading' });
  const [tweetUrl, setTweetUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function init() {
    setError(null);
    try {
      const me = await api.me();
      if (!me.x_handle) {
        setView({ stage: 'bind_required', me });
      } else {
        // Try to start. If ALREADY_ENTERED, jump to the already-entered view.
        try {
          const start = await api.startEntry();
          setView({ stage: 'ready_to_tweet', me, start });
        } catch (e: any) {
          if (e.code === 'ALREADY_ENTERED') {
            setView({ stage: 'already_entered', me });
          } else {
            throw e;
          }
        }
      }
    } catch (e: any) {
      if (e.status === 401) setView({ stage: 'login_required' });
      else setError(e.message ?? String(e));
    }
  }

  useEffect(() => { void init(); }, []);

  async function onVerify() {
    if (view.stage !== 'ready_to_tweet') return;
    setView({ stage: 'verifying', me: view.me, start: view.start });
    setError(null);
    try {
      const result = await api.verifyEntry(tweetUrl);
      setView({ stage: 'done', me: view.me, result });
    } catch (e: any) {
      setError(e.message ?? String(e));
      setView({ stage: 'ready_to_tweet', me: view.me, start: view.start });
    }
  }

  if (view.stage === 'loading') {
    return <EnterShell title="Loading…"><p>Fetching your entry status.</p></EnterShell>;
  }
  if (view.stage === 'login_required') {
    return (
      <EnterShell title="Sign in to enter">
        <p>You need an RPOW account to enter the daily free lottery.</p>
        <p style={{ marginTop: '1rem' }}>
          <a className="cta-primary" href="https://rpow2.com" style={{ display: 'inline-flex', width: 'auto' }}>
            <span>Go to rpow2.com to sign in</span>
            <span className="arrow">→</span>
          </a>
        </p>
      </EnterShell>
    );
  }
  if (view.stage === 'bind_required') {
    return (
      <EnterShell title="Link your X account">
        <p>To enter the lottery you first need to verify an X (Twitter) handle.</p>
        <XHandleClaimModal onVerified={() => void init()} />
      </EnterShell>
    );
  }
  if (view.stage === 'already_entered') {
    return (
      <EnterShell title="You're already in today.">
        <p>Come back tomorrow after 19:00 UTC for the next draw.</p>
        <p style={{ marginTop: '1rem' }}><a href="/">← Back to the lottery</a></p>
      </EnterShell>
    );
  }
  if (view.stage === 'done') {
    return (
      <EnterShell title="You're in.">
        <p>Ticket count: {view.result.ticket_count}. Draw at 19:00 UTC.</p>
        <p style={{ marginTop: '1rem' }}><a href="/">← Back to the lottery</a></p>
      </EnterShell>
    );
  }

  // ready_to_tweet or verifying
  return (
    <EnterShell title="Enter today's free lottery">
      <p>1. Click the button below to post the verification tweet.</p>
      <p>
        <a className="tweet-cta" href={view.start.tweet_intent_url} target="_blank" rel="noreferrer">
          Tweet to enter →
        </a>
      </p>
      <p>2. Paste the URL of the tweet you just posted and click verify.</p>
      <input
        type="url"
        placeholder="https://twitter.com/yourhandle/status/..."
        value={tweetUrl}
        onChange={e => setTweetUrl(e.target.value)}
        disabled={view.stage === 'verifying'}
      />
      <button onClick={onVerify} disabled={view.stage === 'verifying' || tweetUrl.length === 0}>
        {view.stage === 'verifying' ? 'Verifying…' : 'Verify'}
      </button>
      {error ? <p className="error">{error}</p> : null}
      <p className="small">Your code: {view.start.code} · expires {new Date(view.start.expires_at).toUTCString()}</p>
    </EnterShell>
  );
}
