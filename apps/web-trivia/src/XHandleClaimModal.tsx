import { useState } from 'react';
import { startXVerification, verifyXTweet, type XHandleStartResponse } from './api.js';

interface Props {
  onVerified: () => void;
}

export function XHandleClaimModal({ onVerified }: Props) {
  const [step, setStep] = useState<'enter-handle' | 'tweet' | 'verify'>('enter-handle');
  const [handle, setHandle] = useState('');
  const [start, setStart] = useState<XHandleStartResponse | null>(null);
  const [tweetUrl, setTweetUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onStart() {
    setError(null); setBusy(true);
    try {
      const res = await startXVerification(handle);
      setStart(res);
      setStep('tweet');
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  async function onVerify() {
    setError(null); setBusy(true);
    try {
      await verifyXTweet(tweetUrl);
      onVerified();
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>CLAIM YOUR RPOW USERNAME</h2>
        <p style={{ fontSize: 12, color: '#888' }}>
          Your RPOW username is your X handle, verified by tweet. Globally unique per the chain.
        </p>
        {step === 'enter-handle' && (
          <>
            <label>RPOW username (your X handle, without the @):</label>
            <input
              value={handle}
              onChange={e => setHandle(e.target.value)}
              placeholder="elonmusk"
              disabled={busy}
            />
            <button onClick={onStart} disabled={busy || !handle.trim()}>
              { busy ? 'starting...' : 'GET VERIFICATION CODE' }
            </button>
          </>
        )}
        {step === 'tweet' && start && (
          <>
            <p>Claim <strong>@{handle}</strong> by tweeting from that X account:</p>
            <a href={start.tweet_intent_url} target="_blank" rel="noreferrer">
              [ OPEN TWEET COMPOSER ]
            </a>
            <p style={{ marginTop: 16, fontSize: 12 }}>Then paste the URL of your tweet:</p>
            <input
              value={tweetUrl}
              onChange={e => setTweetUrl(e.target.value)}
              placeholder="https://x.com/elonmusk/status/123..."
              disabled={busy}
            />
            <button onClick={onVerify} disabled={busy || !tweetUrl.trim()}>
              { busy ? 'verifying...' : 'VERIFY' }
            </button>
            <button onClick={() => setStep('enter-handle')} disabled={busy} style={{ marginLeft: 8 }}>
              back
            </button>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
