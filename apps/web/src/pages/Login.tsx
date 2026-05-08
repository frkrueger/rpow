import { useState } from 'react';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending'); setError('');
    try {
      await api.authRequest({ email });
      setStatus('sent');
    } catch (err: any) {
      setStatus('error');
      setError(err?.message ?? 'unknown error');
    }
  }

  return (
    <Panel title="LOGIN">
      <form onSubmit={submit}>
        <div>
          EMAIL : <input value={email} onChange={e => setEmail(e.target.value)} required type="email" autoFocus style={{ width: '36ch' }} />
        </div>
        <div style={{ marginTop: 8 }}>
          <button type="submit" disabled={status === 'sending' || status === 'sent'}>
            {status === 'sending' ? '[ SENDING... ]' : status === 'sent' ? '[ LINK SENT ]' : '[ SEND LINK ]'}
          </button>
        </div>
        {status === 'sending' && <div style={{ marginTop: 8, opacity: 0.7 }}>sending magic link — this may take a moment...</div>}
        {status === 'sent' && <div style={{ marginTop: 8 }}>magic link sent! check your inbox (and spam folder). the link expires in 15 minutes.</div>}
        {status === 'error' && (
          <div className="error" style={{ marginTop: 8 }}>
            {error.includes('fetch') || error.includes('network') || error.includes('timeout')
              ? 'server is busy — please wait a moment and try again.'
              : `error: ${error}`}
            {' '}<button type="button" onClick={() => setStatus('idle')} style={{ marginLeft: 8 }}>[ RETRY ]</button>
          </div>
        )}
      </form>
    </Panel>
  );
}
