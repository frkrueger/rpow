import { useState, useEffect, useRef } from 'react';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'cooldown' | 'error'>('idle');
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (cooldown <= 0) return;
    timerRef.current = setInterval(() => {
      setCooldown(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          setStatus('idle');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [cooldown]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending'); setError('');
    try {
      const res = await api.authRequest({ email });
      setStatus('cooldown');
      setCooldown((res as any).cooldown_seconds ?? 30);
    } catch (err: any) {
      if (err?.error === 'RATE_LIMITED') {
        setStatus('cooldown');
        setCooldown(err.retry_after ?? 30);
      } else {
        setStatus('error');
        setError(err?.message ?? 'unknown error');
      }
    }
  }

  const disabled = status === 'sending' || status === 'cooldown';

  return (
    <Panel title="LOGIN">
      <form onSubmit={submit}>
        <div>
          EMAIL : <input value={email} onChange={e => setEmail(e.target.value)} required type="email" autoFocus style={{ width: '36ch' }} />
        </div>
        <div style={{ marginTop: 8 }}>
          <button type="submit" disabled={disabled}>
            {status === 'sending' ? '[ SENDING... ]'
              : status === 'cooldown' ? `[ WAIT ${cooldown}s ]`
              : '[ SEND LINK ]'}
          </button>
        </div>
        {status === 'sending' && (
          <div style={{ marginTop: 8, opacity: 0.7 }}>sending magic link — this may take a moment...</div>
        )}
        {status === 'cooldown' && (
          <div style={{ marginTop: 8 }}>
            magic link sent! check your inbox (and spam folder).<br />
            <span style={{ opacity: 0.5 }}>you can request another in {cooldown}s.</span>
          </div>
        )}
        {status === 'error' && (
          <div className="error" style={{ marginTop: 8 }}>
            {error.includes('fetch') || error.includes('network') || error.includes('timeout') || error.includes('Failed')
              ? 'server is busy — please wait a moment and try again.'
              : `error: ${error}`}
            {' '}<button type="button" onClick={() => setStatus('idle')} style={{ marginLeft: 8 }}>[ RETRY ]</button>
          </div>
        )}
      </form>
    </Panel>
  );
}
