import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { AmmBanner } from '../components/AmmBanner.js';
import { WhatIsRpowPoolModal } from '../components/WhatIsRpowPoolModal.js';
import { useTermsGate } from '../components/TermsModal.js';
import { useMe } from '../hooks/useMe.js';
import { useAmmPool } from '../hooks/useAmmPool.js';
import { useAmmMe } from '../hooks/useAmmMe.js';
import { api } from '../api.js';
import { formatRpow, parseRpowToBaseUnits } from '../lib/format.js';
import {
  minOut, formatUsdc, parseUsdcToBaseUnits, parsePercentToBps,
} from '../lib/amm.js';

const DEBOUNCE_MS = 300;

type Direction = 'BUY' | 'SELL';

export function SwapPage() {
  const { me } = useMe();
  const { pool, refresh: refreshPool } = useAmmPool();
  const { ammMe, refresh: refreshAmm } = useAmmMe();

  const [direction, setDirection] = useState<Direction>('BUY');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState('0.5');
  const [quoteOut, setQuoteOut] = useState<bigint | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ output: string; fee: string } | null>(null);

  const { ensureAccepted, modal } = useTermsGate(
    ammMe?.terms_accepted_at ?? null,
    refreshAmm,
  );

  // Debounced quote refresh on amount change + pool change.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQuoteOut(null);
    if (!amount || !pool || (pool as any).seeded === false) return;
    setQuoteLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        if (direction === 'BUY') {
          const usdcBase = parseUsdcToBaseUnits(amount);
          const q = await api.amm.quoteBuy(usdcBase);
          setQuoteOut(BigInt(q.rpow_out));
        } else {
          const rpowBase = parseRpowToBaseUnits(amount);
          const q = await api.amm.quoteSell(rpowBase);
          setQuoteOut(BigInt(q.usdc_out));
        }
      } catch {
        setQuoteOut(null);
      } finally {
        setQuoteLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [amount, direction, pool]);

  const ammDisallowed = (ammMe === null && !!error) || ((ammMe as any)?.error === 'NOT_ALLOWED');
  const seeded = pool && (pool as any).seeded === true;
  const usdcBalDisplay = ammMe ? formatUsdc(ammMe.usdc_base_units) : '0.00';
  const rpowBalDisplay = me ? formatRpow(me.balance_base_units) : '0';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!seeded || !quoteOut) return;
    setStatus('sending'); setError(''); setResult(null);
    try {
      const slippageBps = parsePercentToBps(slippage);
      const minOutValue = minOut(quoteOut, slippageBps);
      if (!(await ensureAccepted())) {
        setStatus('idle');
        return;
      }
      if (direction === 'BUY') {
        const r = await api.amm.buy({
          usdc_base_units: parseUsdcToBaseUnits(amount),
          min_rpow_out: minOutValue.toString(),
        });
        setStatus('sent');
        setResult({ output: r.output_base_units, fee: r.fee_base_units });
      } else {
        const r = await api.amm.sell({
          rpow_base_units: parseRpowToBaseUnits(amount),
          min_usdc_out: minOutValue.toString(),
        });
        setStatus('sent');
        setResult({ output: r.output_base_units, fee: r.fee_base_units });
      }
      await Promise.all([refreshPool(), refreshAmm()]);
    } catch (err: any) {
      setStatus('error');
      const code = err?.error ?? 'INTERNAL';
      const msgs: Record<string, string> = {
        INSUFFICIENT_BALANCE: 'insufficient balance',
        SLIPPAGE_EXCEEDED: 'price moved against you, try again',
        POOL_NOT_SEEDED: 'pool not yet seeded',
        NOT_ALLOWED: 'AMM access not enabled for your account',
        TERMS_NOT_ACCEPTED: 'terms not accepted',
        BAD_REQUEST: err?.message ?? 'bad request',
      };
      setError(msgs[code] ?? code);
    }
  }

  if (!me) return (
    <Panel title="SWAP">
      <AmmBanner />
      <div>not signed in.</div>
      <div style={{ marginTop: 8 }}><Link to="/login">[ go to login ]</Link></div>
    </Panel>
  );

  if (ammDisallowed) return (
    <Panel title="SWAP">
      <AmmBanner />
      <div>AMM access not enabled for your account.</div>
    </Panel>
  );

  if (pool && (pool as any).seeded === false) return (
    <Panel title="SWAP">
      <AmmBanner />
      <pre style={{ margin: 0 }}>{`  pool not yet seeded.`}</pre>
      <div style={{ marginTop: 12, color: '#888', fontSize: 11 }}>
        <WhatIsRpowPoolModal />
      </div>
    </Panel>
  );

  const balForDirection = direction === 'BUY' ? `${usdcBalDisplay} USDC` : `${rpowBalDisplay} RPOW`;
  const amountUnit = direction === 'BUY' ? 'USDC' : 'RPOW';
  const outUnit = direction === 'BUY' ? 'RPOW' : 'USDC';
  const outDisplay =
    quoteLoading ? '...' :
    quoteOut === null ? '—' :
    direction === 'BUY' ? formatRpow(quoteOut.toString()) : formatUsdc(quoteOut.toString());

  return (
    <Panel title="SWAP">
      <AmmBanner />
      <form onSubmit={submit}>
        <div style={{ marginBottom: 6 }}>
          DIRECTION : {' '}
          <button type="button" onClick={() => setDirection('BUY')} disabled={direction === 'BUY'}>[ BUY RPOW ]</button>
          {' '}
          <button type="button" onClick={() => setDirection('SELL')} disabled={direction === 'SELL'}>[ SELL RPOW ]</button>
        </div>
        <div>YOU PAY   : <input
          type="text" inputMode="decimal" required
          value={amount} onChange={(e) => setAmount(e.target.value)}
          style={{ width: '14ch' }} aria-label="amount in"
        /> {amountUnit} <span style={{ color: '#888' }}>(bal: {balForDirection})</span></div>
        <div style={{ marginTop: 4 }}>SLIPPAGE  : <input
          type="text" inputMode="decimal" required
          value={slippage} onChange={(e) => setSlippage(e.target.value)}
          style={{ width: '6ch' }} aria-label="slippage percent"
        /> %</div>
        <div style={{ marginTop: 6 }}>YOU GET   : ~ {outDisplay} {outUnit}</div>
        <div style={{ marginTop: 8 }}>
          <button type="submit" disabled={status === 'sending' || !quoteOut}>
            [ {status === 'sending' ? '...' : direction}
          </button>
        </div>
      </form>
      {status === 'sent' && result && (
        <pre style={{ margin: '12px 0 0' }}>
{`  + ${direction} ${amount} ${amountUnit} → ${direction === 'BUY' ? formatRpow(result.output) + ' RPOW' : formatUsdc(result.output) + ' USDC'}
  fee: ${direction === 'BUY' ? formatUsdc(result.fee) + ' USDC' : formatRpow(result.fee) + ' RPOW'}`}
        </pre>
      )}
      {status === 'error' && <div className="error" style={{ marginTop: 8 }}>error: {error}</div>}
      <div style={{ marginTop: 12, color: '#888', fontSize: 11 }}>
        <WhatIsRpowPoolModal />
        {pool && (pool as any).seeded && (
          <span style={{ marginLeft: 12 }}>
            pool: {formatRpow((pool as any).reserves.rpow_base_units)} RPOW / {formatUsdc((pool as any).reserves.usdc_base_units)} USDC
          </span>
        )}
      </div>
      {modal}
    </Panel>
  );
}
