import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { AmmBanner } from '../components/AmmBanner.js';
import { WhatIsRpowPoolModal } from '../components/WhatIsRpowPoolModal.js';
import { useTermsGate } from '../components/TermsModal.js';
import { useMe } from '../hooks/useMe.js';
import { useAmmPool } from '../hooks/useAmmPool.js';
import { useAmmMe } from '../hooks/useAmmMe.js';
import { api, type AmmRecentSwap } from '../api.js';
import { formatRpow, parseRpowToBaseUnits } from '../lib/format.js';
import { minOut, formatUsdc, parseUsdcToBaseUnits, parsePercentToBps } from '../lib/amm.js';

export function PoolPage() {
  const { me } = useMe();
  const { pool, refresh: refreshPool } = useAmmPool();
  const { ammMe, refresh: refreshAmm } = useAmmMe();
  const [recent, setRecent] = useState<AmmRecentSwap[]>([]);

  // Add LP form
  const [addRpow, setAddRpow] = useState('');
  const [addUsdc, setAddUsdc] = useState('');
  const [addSlippage, setAddSlippage] = useState('0.5');
  const [addStatus, setAddStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [addError, setAddError] = useState('');

  // Remove LP form
  const [rmLp, setRmLp] = useState('');
  const [rmSlippage, setRmSlippage] = useState('0.5');
  const [rmStatus, setRmStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [rmError, setRmError] = useState('');

  const { ensureAccepted, modal } = useTermsGate(
    ammMe?.terms_accepted_at ?? null,
    refreshAmm,
  );

  // Fetch recent swaps on mount and after writes.
  async function loadRecent() {
    try {
      const r = await api.amm.swapsRecent();
      setRecent(r.swaps.slice(0, 5));
    } catch { /* ignore — non-critical */ }
  }
  useEffect(() => { loadRecent(); }, []);

  const ammDisallowed = (ammMe as any)?.error === 'NOT_ALLOWED';
  const seeded = pool && (pool as any).seeded === true;

  if (!me) return (
    <Panel title="POOL">
      <AmmBanner />
      <div>not signed in.</div>
      <div style={{ marginTop: 8 }}><Link to="/login">[ go to login ]</Link></div>
    </Panel>
  );

  if (ammDisallowed) return (
    <Panel title="POOL">
      <AmmBanner />
      <div>AMM access not enabled for your account.</div>
    </Panel>
  );

  if (pool && (pool as any).seeded === false) return (
    <Panel title="POOL">
      <AmmBanner />
      <pre style={{ margin: 0 }}>{`  pool not yet seeded.`}</pre>
      <div style={{ marginTop: 12, color: '#888', fontSize: 11 }}>
        <WhatIsRpowPoolModal />
      </div>
    </Panel>
  );

  if (!seeded || !pool) return (
    <Panel title="POOL">
      <AmmBanner />
      <div>loading...</div>
    </Panel>
  );

  const reserves = (pool as any).reserves as { rpow_base_units: string; usdc_base_units: string };
  const totalLp = BigInt((pool as any).total_lp_supply);
  const userLp = ammMe ? BigInt(ammMe.lp_balance) : 0n;
  const sharePct = totalLp > 0n ? Number((userLp * 10000n) / totalLp) / 100 : 0;
  const userRpowShare = totalLp > 0n ? (BigInt(reserves.rpow_base_units) * userLp) / totalLp : 0n;
  const userUsdcShare = totalLp > 0n ? (BigInt(reserves.usdc_base_units) * userLp) / totalLp : 0n;

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddStatus('sending'); setAddError('');
    try {
      const rpowBase = parseRpowToBaseUnits(addRpow);
      const usdcBase = parseUsdcToBaseUnits(addUsdc);
      const slippageBps = parsePercentToBps(addSlippage);
      // Estimate LP minted as min(rpow_in / pool_rpow, usdc_in / pool_usdc) * total_lp.
      const lpFromRpow = (BigInt(rpowBase) * totalLp) / BigInt(reserves.rpow_base_units);
      const lpFromUsdc = (BigInt(usdcBase) * totalLp) / BigInt(reserves.usdc_base_units);
      const estLp = lpFromRpow < lpFromUsdc ? lpFromRpow : lpFromUsdc;
      const minLpOut = minOut(estLp, slippageBps);
      if (!(await ensureAccepted())) {
        setAddStatus('idle');
        return;
      }
      await api.amm.lpAdd({
        rpow_base_units: rpowBase,
        usdc_base_units: usdcBase,
        min_lp_out: minLpOut.toString(),
      });
      setAddStatus('sent');
      await Promise.all([refreshPool(), refreshAmm(), loadRecent()]);
    } catch (err: any) {
      setAddStatus('error');
      setAddError(err?.message ?? err?.error ?? 'failed to add liquidity');
    }
  }

  async function submitRemove(e: React.FormEvent) {
    e.preventDefault();
    setRmStatus('sending'); setRmError('');
    try {
      const lpBase = parseRpowToBaseUnits(rmLp); // LP uses 9 decimals like RPOW
      const slippageBps = parsePercentToBps(rmSlippage);
      // Pro-rata estimate
      const estRpow = (BigInt(lpBase) * BigInt(reserves.rpow_base_units)) / totalLp;
      const estUsdc = (BigInt(lpBase) * BigInt(reserves.usdc_base_units)) / totalLp;
      if (!(await ensureAccepted())) {
        setRmStatus('idle');
        return;
      }
      await api.amm.lpRemove({
        lp_base_units: lpBase,
        min_rpow_out: minOut(estRpow, slippageBps).toString(),
        min_usdc_out: minOut(estUsdc, slippageBps).toString(),
      });
      setRmStatus('sent');
      await Promise.all([refreshPool(), refreshAmm(), loadRecent()]);
    } catch (err: any) {
      setRmStatus('error');
      setRmError(err?.message ?? err?.error ?? 'failed to remove liquidity');
    }
  }

  return (
    <Panel title="POOL">
      <AmmBanner />

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 'bold', marginBottom: 4 }}>POOL</div>
        reserves : {formatRpow(reserves.rpow_base_units)} RPOW  /  {formatUsdc(reserves.usdc_base_units)} USDC<br/>
        fee      : {((pool as any).fee_bps / 100).toFixed(2)}%<br/>
        your LP  : {formatRpow(userLp.toString())} LP  ({sharePct.toFixed(2)}% share)<br/>
        your RPOW share : {formatRpow(userRpowShare.toString())} RPOW<br/>
        your USDC share : {formatUsdc(userUsdcShare.toString())} USDC
      </div>

      <form onSubmit={submitAdd} style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 'bold', marginBottom: 4 }}>ADD LIQUIDITY</div>
        <div>RPOW IN  : <input
          type="text" inputMode="decimal" required value={addRpow}
          onChange={(e) => setAddRpow(e.target.value)} style={{ width: '14ch' }}
          aria-label="add rpow in"
        /> RPOW</div>
        <div>USDC IN  : <input
          type="text" inputMode="decimal" required value={addUsdc}
          onChange={(e) => setAddUsdc(e.target.value)} style={{ width: '14ch' }}
          aria-label="add usdc in"
        /> USDC</div>
        <div>SLIPPAGE : <input
          type="text" inputMode="decimal" required value={addSlippage}
          onChange={(e) => setAddSlippage(e.target.value)} style={{ width: '6ch' }}
          aria-label="add slippage percent"
        /> %</div>
        <div style={{ marginTop: 6 }}>
          <button type="submit" disabled={addStatus === 'sending'}>
            [ {addStatus === 'sending' ? '...' : 'ADD'} ]
          </button>
        </div>
        {addStatus === 'sent' && <pre style={{ margin: '6px 0 0' }}>  + LIQUIDITY ADDED</pre>}
        {addStatus === 'error' && <div className="error">error: {addError}</div>}
      </form>

      <form onSubmit={submitRemove} style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 'bold', marginBottom: 4 }}>REMOVE LIQUIDITY</div>
        <div>LP BURN  : <input
          type="text" inputMode="decimal" required value={rmLp}
          onChange={(e) => setRmLp(e.target.value)} style={{ width: '14ch' }}
          disabled={userLp === 0n}
          aria-label="remove lp burn"
        /> LP {userLp === 0n && <span style={{ color: '#888' }}>(no LP)</span>}</div>
        <div>SLIPPAGE : <input
          type="text" inputMode="decimal" required value={rmSlippage}
          onChange={(e) => setRmSlippage(e.target.value)} style={{ width: '6ch' }}
          disabled={userLp === 0n}
          aria-label="remove slippage percent"
        /> %</div>
        <div style={{ marginTop: 6 }}>
          <button type="submit" disabled={rmStatus === 'sending' || userLp === 0n}>
            [ {rmStatus === 'sending' ? '...' : 'REMOVE'} ]
          </button>
        </div>
        {rmStatus === 'sent' && <pre style={{ margin: '6px 0 0' }}>  + LIQUIDITY REMOVED</pre>}
        {rmStatus === 'error' && <div className="error">error: {rmError}</div>}
      </form>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 'bold', marginBottom: 4 }}>RECENT SWAPS</div>
        {recent.length === 0 ? (
          <div style={{ color: '#888' }}>(no swaps yet)</div>
        ) : (
          recent.map((s) => (
            <div key={s.id} style={{ fontSize: 12 }}>
              <span style={{ color: '#888' }}>{new Date(s.created_at).toLocaleTimeString()}</span>
              {' '}{s.direction}{' '}
              {s.direction === 'BUY'
                ? `${formatUsdc(s.usdc_delta_base_units)} USDC → ${formatRpow(s.rpow_delta_base_units)} RPOW`
                : `${formatRpow(s.rpow_delta_base_units)} RPOW → ${formatUsdc(s.usdc_delta_base_units)} USDC`}
            </div>
          ))
        )}
      </div>

      <div style={{ color: '#888', fontSize: 11 }}>
        <WhatIsRpowPoolModal />
      </div>
      {modal}
    </Panel>
  );
}
