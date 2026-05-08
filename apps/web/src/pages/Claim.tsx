import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { api, type ClaimStatus } from '../api.js';
import { useMe } from '../hooks/useMe.js';

type LoadState = 'loading' | 'ready' | 'claiming' | 'claimed' | 'error';

function fmtDate(s?: string | null) {
  if (!s) return '--';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

function claimError(err: any) {
  const code = err?.error;
  if (code === 'INVALID_CLAIM') return 'invalid claim link';
  if (code === 'CLAIM_EXPIRED') return 'this claim link has expired';
  if (code === 'ALREADY_CLAIMED') return 'this gift has already been redeemed';
  if (code === 'BAD_REQUEST') return err?.message ?? 'missing claim token';
  return err?.message ?? 'network error while checking claim';
}

export function ClaimPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { refresh } = useMe();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<LoadState>('loading');
  const [claim, setClaim] = useState<ClaimStatus | null>(null);
  const [error, setError] = useState('');
  const [claimedSummary, setClaimedSummary] = useState<{ email: string; amount: number } | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      if (!token) {
        setState('error');
        setError('missing claim token');
        return;
      }
      setState('loading');
      setError('');
      try {
        const next = await api.claimStatus(token);
        if (!alive) return;
        setClaim(next);
        setState('ready');
      } catch (err: any) {
        if (!alive) return;
        setState('error');
        setError(claimError(err));
      }
    }
    load();
    return () => { alive = false; };
  }, [token]);

  async function redeem() {
    if (!token || !claim || claim.status !== 'pending') return;
    setState('claiming');
    setError('');
    try {
      const res = await api.claim(token);
      setClaimedSummary({ email: res.recipient_email, amount: res.amount });
      setState('claimed');
      await refresh();
      window.setTimeout(() => nav('/'), 350);
    } catch (err: any) {
      setState('error');
      setError(claimError(err));
    }
  }

  const inactiveReason =
    claim?.status === 'expired' ? 'this claim link has expired'
      : claim?.status === 'claimed' ? 'this gift has already been redeemed'
        : claim?.status === 'canceled' ? 'the sender canceled this pending transfer'
          : '';

  return (
    <Panel title="CLAIM LANDING">
      {state === 'loading' && <div>checking claim...</div>}
      {state === 'error' && (
        <>
          <div className="error">error: {error}</div>
          <div style={{ marginTop: 8 }}><Link to="/">[ return to wallet ]</Link></div>
        </>
      )}
      {(state === 'ready' || state === 'claiming') && claim && (
        <>
          <pre style={{ margin: 0 }}>
{`  FROM       : ${claim.sender_email}
  TO         : ${claim.recipient_email}
  AMOUNT     : ${claim.amount} RPOW
  EXPIRES    : ${fmtDate(claim.expires_at)}
  STATUS     : ${claim.status.toUpperCase()}
`}
          </pre>
          {inactiveReason && <div className="error" style={{ marginTop: 8 }}>{inactiveReason}</div>}
          <div style={{ marginTop: 8 }}>
            <button onClick={redeem} disabled={state === 'claiming' || claim.status !== 'pending'}>
              {state === 'claiming' ? '[ CLAIMING... ]' : `[ CLAIM ${claim.amount} RPOW ]`}
            </button>
          </div>
        </>
      )}
      {state === 'claimed' && claimedSummary && (
        <>
          <pre style={{ margin: 0 }}>
{`  + CLAIMED ${claimedSummary.amount} RPOW
  WALLET    : ${claimedSummary.email}
  NEXT      : opening wallet...`}
          </pre>
          <div style={{ marginTop: 8 }}><Link to="/">[ open wallet ]</Link></div>
        </>
      )}
    </Panel>
  );
}
