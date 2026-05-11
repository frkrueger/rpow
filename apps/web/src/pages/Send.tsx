import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import { useMe } from '../hooks/useMe.js';
import { formatRpow, parseRpowToBaseUnits } from '../lib/format.js';
import { ALLOWED_RETURN_ORIGINS, resolveReturnTarget } from '../lib/returnUrl.js';

export function SendPage() {
  const { me, refresh } = useMe();
  const [searchParams] = useSearchParams();
  const [recipient, setRecipient] = useState('');
  // Decimal RPOW string typed by the user; converted to base units on submit.
  const [amount, setAmount] = useState('1');
  const [memo, setMemo] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const [transferId, setTransferId] = useState('');
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const [sentAmt, setSentAmt] = useState('');
  const [returnTarget, setReturnTarget] = useState<URL | null>(null);

  // URL prefill — supports `https://rpow2.com/#/send?to=email&amount=N&memo=abc&return_url=…`
  // (and the equivalent /wallet link, which redirects here). Read once on mount.
  useEffect(() => {
    const to = searchParams.get('to');
    const amt = searchParams.get('amount');
    const m = searchParams.get('memo');
    if (to) setRecipient(to);
    if (amt) setAmount(amt);
    if (m) setMemo(m);
    setReturnTarget(resolveReturnTarget(searchParams.get('return_url'), ALLOWED_RETURN_ORIGINS));
    // intentionally not depending on searchParams — prefill only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const balanceDisplay = me ? formatRpow(me.balance_base_units) : '0';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!me) return;
    setStatus('sending'); setError(''); setPending(false);
    let amount_base_units: string;
    try {
      amount_base_units = parseRpowToBaseUnits(amount);
    } catch {
      setStatus('error');
      setError('invalid amount (max 9 decimal places)');
      return;
    }
    try {
      const r = await api.send({
        recipient_email: recipient,
        amount_base_units,
        idempotency_key: crypto.randomUUID(),
        memo: memo.trim() || undefined,
      });
      setStatus('sent');
      setTransferId(r.transfer_id);
      setPending(r.pending === true);
      setSentTo(r.recipient_email);
      setSentAmt(formatRpow(r.transferred_base_units));
      window.gtag?.('event', 'send_tokens', { value: r.transferred_base_units });
      await refresh();
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

  if (!me) return (
    <Panel title="SEND">
      <div>not signed in.</div>
      <div style={{ marginTop: 8 }}><Link to="/login">[ go to login ]</Link></div>
    </Panel>
  );

  return (
    <Panel title="SEND">
      <form onSubmit={submit}>
        <div>TO     : <input type="email" required value={recipient} onChange={e => setRecipient(e.target.value)} style={{ width: '40ch' }} /></div>
        <div style={{ marginTop: 4 }}>AMOUNT : <input type="text" inputMode="decimal" required value={amount} onChange={e => setAmount(e.target.value)} style={{ width: '14ch' }} /> RPOW <span style={{ color: '#888' }}>(balance: {balanceDisplay})</span></div>
        <div style={{ marginTop: 4 }}>MEMO   : <input type="text" value={memo} onChange={e => setMemo(e.target.value.slice(0, 256))} placeholder="optional context, alphanumeric + - _" maxLength={256} pattern="[A-Za-z0-9_\-]*" style={{ width: '40ch' }} /> <span style={{ color: '#888', fontSize: 11 }}>(optional, ≤256)</span></div>
        <div style={{ marginTop: 8 }}>
          <button type="submit" disabled={status === 'sending'}>[ {status === 'sending' ? '...' : 'SEND'} ]</button>
        </div>
      </form>
      {status === 'sent' && !pending && (
        <pre style={{ margin: '12px 0 0' }}>
{`  + SENT  ${sentAmt} RPOW → ${sentTo}${memo ? `\n  memo: ${memo}` : ''}
  transfer id: ${transferId}`}
        </pre>
      )}
      {status === 'sent' && pending && (
        <pre style={{ margin: '12px 0 0' }}>
{`  + PENDING CLAIM
  ${sentTo} does not have an rpow2 account yet.
  An email has been sent inviting them to claim ${sentAmt} RPOW.
  Your tokens are reserved until they claim or the link expires (30d).
  transfer id: ${transferId}`}
        </pre>
      )}
      {status === 'error' && <div className="error" style={{ marginTop: 8 }}>error: {error}</div>}
    </Panel>
  );
}
