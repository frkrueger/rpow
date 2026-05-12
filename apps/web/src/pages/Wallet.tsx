import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { useMe } from '../hooks/useMe.js';
import { api } from '../api.js';
import { formatRpow, formatUsdc, parseRpowToBaseUnits } from '../lib/format.js';
import { AMM_PILOT_EMAILS } from '../lib/ammPilot.js';

/** Best-effort safety check on a return_url. Accept http(s) only. Reject
 *  data:, javascript:, file:, etc. Reject malformed URLs. The displayed
 *  hostname lets the user verify before clicking, so we don't need a
 *  domain allowlist. */
function safeReturnUrl(raw: string | null): { url: string; host: string } | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return { url: u.toString(), host: u.host };
  } catch { return null; }
}

/** Inline pay-request card shown on /wallet when the URL has ?to=…&amount=…&memo=…
 *  query params. One-click confirm submits a normal /send call. After success
 *  the user is already on /wallet, so the balance updates inline. */
function PayRequestCard({
  to, amount, memo, returnUrl, onSent,
}: {
  to: string;
  amount: string;
  memo: string | null;
  returnUrl: string | null;
  onSent: () => Promise<void>;
}) {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const [transferId, setTransferId] = useState('');
  const [pending, setPending] = useState(false);

  async function confirm() {
    setStatus('sending'); setError('');
    let amount_base_units: string;
    try {
      amount_base_units = parseRpowToBaseUnits(amount);
    } catch {
      setStatus('error');
      setError('invalid amount in URL');
      return;
    }
    try {
      const r = await api.send({
        recipient_email: to,
        amount_base_units,
        idempotency_key: crypto.randomUUID(),
        memo: memo ?? undefined,
      });
      setStatus('sent');
      setTransferId(r.transfer_id);
      setPending(r.pending === true);
      await onSent();
    } catch (err: any) {
      setStatus('error');
      const code = err?.error ?? 'INTERNAL';
      const msgs: Record<string, string> = {
        INSUFFICIENT_BALANCE: 'not enough tokens in your wallet',
        BAD_REQUEST: err?.message ?? 'bad request',
        RATE_LIMITED: err?.message ?? 'too many attempts',
      };
      setError(msgs[code] ?? code);
    }
  }

  return (
    <Panel title="PAY REQUEST">
      <div style={{ fontSize: 12, color: 'var(--dim)', marginBottom: 8 }}>
        Someone shared a payment link. Confirm before sending.
      </div>
      <div>TO     : <strong>{to}</strong></div>
      <div>AMOUNT : <strong>{amount} RPOW</strong></div>
      {memo && <div>MEMO   : <code style={{ background: 'rgba(110,231,183,0.06)', padding: '0 4px' }}>{memo}</code></div>}
      <div style={{ marginTop: 12 }}>
        <button
          className="primary"
          onClick={confirm}
          disabled={status === 'sending' || status === 'sent'}
        >
          [ {status === 'sending' ? 'sending…' : status === 'sent' ? 'sent' : `CONFIRM SEND ${amount} RPOW`} ]
        </button>
      </div>
      {status === 'sent' && !pending && (
        <pre style={{ margin: '12px 0 0' }}>
{`  + SENT  ${amount} RPOW → ${to}${memo ? `\n  memo: ${memo}` : ''}
  transfer id: ${transferId}`}
        </pre>
      )}
      {status === 'sent' && pending && (
        <pre style={{ margin: '12px 0 0' }}>
{`  + PENDING CLAIM
  ${to} does not have an rpow2 account yet.
  An email has been sent inviting them to claim.
  transfer id: ${transferId}`}
        </pre>
      )}
      {status === 'sent' && returnUrl && (() => {
        const safe = safeReturnUrl(returnUrl);
        if (!safe) return null;
        return (
          <div style={{ marginTop: 12 }}>
            <a href={safe.url} className="primary" style={{ display: 'inline-block', padding: '4px 12px', border: '1px solid var(--accent)', textDecoration: 'none' }}>
              [ RETURN TO {safe.host} ↗ ]
            </a>
          </div>
        );
      })()}
      {status === 'error' && <div className="error" style={{ marginTop: 8 }}>error: {error}</div>}
    </Panel>
  );
}

export function WalletPage() {
  const { me, loading, refresh } = useMe();
  const [searchParams] = useSearchParams();
  const toParam = searchParams.get('to');
  const amountParam = searchParams.get('amount');
  const memoParam = searchParams.get('memo');
  const returnUrlParam = searchParams.get('return_url');
  const hasPayRequest = !!(toParam && amountParam);

  if (loading) return <Panel><div>loading...</div></Panel>;
  if (!me) return (
    <>
      {hasPayRequest && (
        <Panel title="PAY REQUEST">
          <div style={{ fontSize: 12, color: 'var(--dim)', marginBottom: 8 }}>
            Someone shared a payment link. Sign in to confirm before sending.
          </div>
          <div>TO     : <strong>{toParam}</strong></div>
          <div>AMOUNT : <strong>{amountParam} RPOW</strong></div>
          {memoParam && <div>MEMO   : <code style={{ background: 'rgba(110,231,183,0.06)', padding: '0 4px' }}>{memoParam}</code></div>}
        </Panel>
      )}
      <Panel title="WALLET">
        <div>not signed in.</div>
        <div style={{ marginTop: 8 }}>
          <Link to="/login">[ go to login ]</Link>
        </div>
      </Panel>
    </>
  );

  async function logout() {
    await api.logout();
    await refresh();
  }

  return (
    <>
      {hasPayRequest && (
        <PayRequestCard
          to={toParam!}
          amount={amountParam!}
          memo={memoParam}
          returnUrl={returnUrlParam}
          onSent={refresh}
        />
      )}
      <Panel title="WALLET" status={me.email}>
        <div className="stat-grid">
          <div className="stat-cell full">
            <div className="stat-label">BALANCE</div>
            <div className="stat-value highlight">{formatRpow(me.balance_base_units)} RPOW</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">MINTED</div>
            <div className="stat-value">{formatRpow(me.minted_base_units)}</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">RECEIVED</div>
            <div className="stat-value">{formatRpow(me.received_base_units)}</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">SENT</div>
            <div className="stat-value">{formatRpow(me.sent_base_units)}</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">DAILY REMAINING</div>
            <div className="stat-value">{me.daily_remaining_base_units ? formatRpow(me.daily_remaining_base_units) : '—'}</div>
          </div>
          {AMM_PILOT_EMAILS.has(me.email) && (
            <div className="stat-cell">
              <div className="stat-label">USDC</div>
              <div className="stat-value">{formatUsdc(me.usdc_base_units)}</div>
            </div>
          )}
        </div>
        <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <Link to="/mine"><button className="primary">[ MINE ]</button></Link>
          <Link to="/send"><button>[ SEND ]</button></Link>
          <Link to="/activity"><button>[ ACTIVITY ]</button></Link>
          <button onClick={logout}>[ LOGOUT ]</button>
        </div>
      </Panel>
    </>
  );
}
