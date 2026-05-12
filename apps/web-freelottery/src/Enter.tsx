import { useEffect, useState } from 'react';
import { api, Me, StartResponse, VerifyResponse } from './api.js';
import { XHandleClaimModal } from './XHandleClaimModal.js';

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

  if (view.stage === 'loading') return <main><p>Loading…</p></main>;
  if (view.stage === 'login_required') {
    return (
      <main>
        <h1>Sign in to enter</h1>
        <p>You need an RPOW account to enter the daily free lottery.</p>
        <p><a href="https://rpow2.com">Go to rpow2.com to sign in →</a></p>
      </main>
    );
  }
  if (view.stage === 'bind_required') {
    return (
      <main>
        <h1>Link your X account</h1>
        <p>To enter the lottery you first need to verify an X (Twitter) handle.</p>
        <XHandleClaimModal onVerified={() => void init()} />
      </main>
    );
  }
  if (view.stage === 'already_entered') {
    return (
      <main>
        <h1>You're already in today.</h1>
        <p>Come back tomorrow after 19:00 UTC for the next draw.</p>
        <p><a href="/">← Back to the lottery</a></p>
      </main>
    );
  }
  if (view.stage === 'done') {
    return (
      <main>
        <h1>You're in.</h1>
        <p>Ticket count: {view.result.ticket_count}. Draw at 19:00 UTC.</p>
        <p><a href="/">← Back to the lottery</a></p>
      </main>
    );
  }

  // ready_to_tweet or verifying
  return (
    <main>
      <h1>Enter today's free lottery</h1>
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
    </main>
  );
}
