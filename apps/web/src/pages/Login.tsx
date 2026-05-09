import { useState, useEffect, useRef, useCallback } from 'react';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      reset(widgetId: string): void;
      remove(widgetId: string): void;
    };
  }
}

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'cooldown' | 'error'>('idle');
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

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

  const renderTurnstile = useCallback(() => {
    if (!TURNSTILE_SITE_KEY || !turnstileRef.current || !window.turnstile) return;
    if (widgetIdRef.current) {
      window.turnstile.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    }
    widgetIdRef.current = window.turnstile.render(turnstileRef.current, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: 'dark',
      callback: (token: string) => setTurnstileToken(token),
      'expired-callback': () => setTurnstileToken(null),
      'error-callback': () => setTurnstileToken(null),
    });
  }, []);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    if (window.turnstile) {
      renderTurnstile();
    } else {
      const interval = setInterval(() => {
        if (window.turnstile) {
          clearInterval(interval);
          renderTurnstile();
        }
      }, 200);
      return () => clearInterval(interval);
    }
  }, [renderTurnstile]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending'); setError('');

    let turnstile_token: string | undefined;
    if (TURNSTILE_SITE_KEY) {
      turnstile_token = turnstileToken ?? undefined;
      if (!turnstile_token) {
        setStatus('error');
        setError('please complete the human-verification challenge');
        return;
      }
    }

    try {
      const res = await api.authRequest({ email, turnstile_token });
      setStatus('cooldown');
      setCooldown((res as any).cooldown_seconds ?? 30);
      setTurnstileToken(null);
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
      }
    } catch (err: any) {
      if (err?.error === 'RATE_LIMITED') {
        setStatus('cooldown');
        setCooldown(err.retry_after ?? 30);
      } else if (err?.error === 'TURNSTILE_REQUIRED' || err?.error === 'TURNSTILE_INVALID') {
        setStatus('error');
        setError('human verification failed; refresh and try again');
        if (widgetIdRef.current && window.turnstile) {
          window.turnstile.reset(widgetIdRef.current);
        }
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
        {TURNSTILE_SITE_KEY && (
          <div style={{ marginTop: 12 }} ref={turnstileRef} />
        )}
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
