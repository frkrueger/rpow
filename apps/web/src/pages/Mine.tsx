import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { useMe } from '../hooks/useMe.js';
import { api } from '../api.js';
import { formatRpow } from '../lib/format.js';
import type { LedgerResponse } from '@rpow/shared';

type Status = 'idle' | 'mining' | 'submitting' | 'error';

export function MinePage() {
  const { me, loading, refresh } = useMe();
  const nav = useNavigate();
  const [status, setStatus] = useState<Status>('idle');
  const [target, setTarget] = useState<number | null>(null);
  const [hashes, setHashes] = useState('0');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [lastTokenId, setLastTokenId] = useState('');
  const [sessionMinted, setSessionMinted] = useState(0);
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const workerRef = useRef<Worker | null>(null);
  // Use a ref (not state) so the async worker callback always sees the latest value
  // without restarting the loop closure.
  const stopRequestedRef = useRef(false);

  useEffect(() => () => {
    stopRequestedRef.current = true;
    workerRef.current?.terminate();
  }, []);

  // Pull halving info on mount and after each successful mint so the
  // "next halving at" countdown stays roughly current.
  const refreshLedger = () => { api.ledger().then(setLedger).catch(() => {}); };
  useEffect(() => { refreshLedger(); }, []);

  async function startOne() {
    if (stopRequestedRef.current) { setStatus('idle'); return; }
    setStatus('mining');
    setError('');
    setHashes('0');
    setElapsed(0);

    let ch;
    try {
      ch = await api.challenge();
    } catch (err: any) {
      if (err?.error === 'COOLDOWN') {
        const wait = (err.retry_after ?? 5) * 1000;
        await new Promise(r => setTimeout(r, wait));
        if (!stopRequestedRef.current) startOne();
        else setStatus('idle');
        return;
      }
      setStatus('error');
      setError(err?.message ?? 'failed to fetch challenge');
      return;
    }
    setTarget(ch.difficulty_bits);

    const w = new Worker(new URL('../miner.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = w;
    w.onmessage = async (e: MessageEvent<any>) => {
      const m = e.data;
      if (m.type === 'progress') { setHashes(m.hashes); setElapsed(m.elapsed_ms); return; }
      if (m.type === 'aborted') {
        w.terminate(); workerRef.current = null;
        setStatus('idle');
        return;
      }
      if (m.type === 'found') {
        setStatus('submitting');
        w.terminate(); workerRef.current = null;
        try {
          const r = await api.mint({ challenge_id: ch.challenge_id, solution_nonce: m.solution_nonce });
          setLastTokenId(r.token.id);
          setSessionMinted(n => n + 1);
          window.gtag?.('event', 'mint_token', { value: Number(r.token.value_base_units) });
          await refresh();
          refreshLedger();
          // Loop: kick off the next challenge unless the user asked to stop.
          if (!stopRequestedRef.current) {
            startOne();
          } else {
            setStatus('idle');
          }
        } catch (err: any) {
          setStatus('error');
          setError(err?.message ?? 'mint failed');
        }
      }
    };
    w.postMessage({ type: 'start', nonce_prefix: ch.nonce_prefix, difficulty_bits: ch.difficulty_bits });
  }

  function start() {
    if (!me) { nav('/login'); return; }
    stopRequestedRef.current = false;
    setSessionMinted(0);
    setLastTokenId('');
    startOne();
  }

  function stop() {
    stopRequestedRef.current = true;
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'abort' });
    } else {
      setStatus('idle');
    }
  }

  function fmtRate() {
    if (!elapsed) return '0';
    const h = Number(hashes);
    const mhs = (h / 1e6) / (elapsed / 1000);
    return mhs.toFixed(2) + ' MH/s';
  }
  function fmtElapsed() {
    const s = Math.floor(elapsed / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `00:${mm}:${ss}`;
  }

  if (loading) return <Panel><div>loading...</div></Panel>;
  if (!me) return <Panel title="MINE"><div>not signed in.</div></Panel>;

  const running = status === 'mining' || status === 'submitting';
  const statusLabel = running
    ? <><span className="status-dot active" />ACTIVE</>
    : <><span className="status-dot idle" />{status.toUpperCase()}</>;

  return (
    <Panel title="MINING" status={statusLabel}>
      <div className="mine-grid">
        {ledger && <>
          <span className="key">REWARD</span><span className="val">{formatRpow(ledger.current_reward_base_units)} RPOW / solution</span>
          <span className="key">DIFFICULTY</span><span className="val">{ledger.current_difficulty_bits} bits</span>
        </>}
        <span className="key">HASHES</span><span className="val active">{Number(hashes).toLocaleString()}</span>
        <span className="key">RATE</span><span className="val active">{fmtRate()}</span>
        <span className="key">ELAPSED</span><span className="val">{fmtElapsed()}</span>
        <span className="key">MINED</span><span className="val active">{sessionMinted} this session</span>
        {lastTokenId && <><span className="key">LAST TOKEN</span><span className="val" style={{ fontSize: 11 }}>{lastTokenId}</span></>}
        {error && <><span className="key">ERROR</span><span className="val" style={{ color: 'var(--error)' }}>{error}</span></>}
      </div>
      {running && <div className="hash-bar"><div className="hash-bar-fill" /></div>}
      {ledger && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--dim)', marginTop: running ? 0 : 12 }}>
          <span>next halving: {formatRpow(ledger.base_units_to_next_halving)} RPOW to go</span>
          {me.daily_remaining_base_units && <span>daily remaining: {formatRpow(me.daily_remaining_base_units)}</span>}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        {running ? (
          <button className="danger" onClick={stop}>[ STOP ]</button>
        ) : (
          <button className="primary" onClick={start}>[ MINE ]</button>
        )}
      </div>
    </Panel>
  );
}
