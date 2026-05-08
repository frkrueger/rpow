import { useEffect, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { api, type PendingTransfer } from '../api.js';
import { useMe } from '../hooks/useMe.js';

function fmtDate(s?: string | null) {
  if (!s) return '--';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString();
}

export function SendPage() {
  const { me, refresh } = useMe();
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState(1);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const [transferId, setTransferId] = useState('');
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const [sentAmt, setSentAmt] = useState(0);
  const [pendingTransfers, setPendingTransfers] = useState<PendingTransfer[]>([]);
  const [pendingError, setPendingError] = useState('');
  const [pendingAction, setPendingAction] = useState('');

  async function loadPending() {
    if (!me) return;
    setPendingError('');
    try {
      setPendingTransfers(await api.pendingTransfers());
    } catch (err: any) {
      setPendingError(err?.message ?? 'failed to load pending transfers');
    }
  }

  useEffect(() => { loadPending(); }, [me?.email]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!me) return;
    setStatus('sending'); setError(''); setPending(false);
    try {
      const r = await api.send({ recipient_email: recipient, amount, idempotency_key: crypto.randomUUID() });
      setStatus('sent');
      setTransferId(r.transfer_id);
      setPending(r.pending === true);
      setSentTo(r.recipient_email);
      setSentAmt(r.transferred);
      await refresh();
      await loadPending();
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

  async function resend(id: string) {
    setPendingAction(id);
    setPendingError('');
    try {
      await api.resendPendingTransfer(id);
    } catch (err: any) {
      setPendingError(err?.message ?? 'failed to resend claim email');
    } finally {
      setPendingAction('');
    }
  }

  async function cancel(id: string) {
    setPendingAction(id);
    setPendingError('');
    try {
      await api.cancelPendingTransfer(id);
      await loadPending();
      await refresh();
    } catch (err: any) {
      setPendingError(err?.message ?? 'failed to cancel transfer');
    } finally {
      setPendingAction('');
    }
  }

  if (!me) return <Panel title="SEND"><div>not signed in.</div></Panel>;

  return (
    <>
      <Panel title="SEND">
        <form onSubmit={submit}>
          <div>TO     : <input type="email" required value={recipient} onChange={e => setRecipient(e.target.value)} style={{ width: '40ch' }} /></div>
          <div style={{ marginTop: 4 }}>AMOUNT : <input type="number" min={1} max={me.balance} required value={amount} onChange={e => setAmount(Number(e.target.value))} style={{ width: '10ch' }} /> RPOW</div>
          <div style={{ marginTop: 8 }}>
            <button type="submit" disabled={status === 'sending'}>[ {status === 'sending' ? '...' : 'SEND'} ]</button>
          </div>
        </form>
        {status === 'sent' && !pending && (
          <pre style={{ margin: '12px 0 0' }}>
{`  + SENT  ${sentAmt} RPOW → ${sentTo}
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

      <Panel title="PENDING TRANSFERS">
        {pendingError && <div className="error">error: {pendingError}</div>}
        {pendingTransfers.length === 0 ? (
          <div className="dim">(no pending transfers)</div>
        ) : (
          <div className="pending-list">
            {pendingTransfers.map(t => {
              const canAct = t.status === 'pending' || t.status === 'expired';
              return (
                <div className="pending-row" key={t.id}>
                  <pre style={{ margin: 0 }}>
{`  TO      : ${t.recipient_email}
  AMOUNT  : ${t.amount} RPOW
  EXPIRES : ${fmtDate(t.expires_at)}
  STATUS  : ${t.status.toUpperCase()}`}
                  </pre>
                  <div className="pending-actions">
                    <button onClick={() => resend(t.id)} disabled={!canAct || pendingAction === t.id}>[ resend ]</button>
                    <button onClick={() => cancel(t.id)} disabled={!canAct || pendingAction === t.id}>[ cancel ]</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </>
  );
}
