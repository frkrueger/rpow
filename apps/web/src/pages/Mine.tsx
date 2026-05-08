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
    workerRef.current?.postMessage({ type: 'abort' });
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

  // Halving / reward block (when ledger has loaded). Shown above the per-run
  // mining stats so users see what they're actually mining for.
  let rewardBlock = '';
  if (ledger) {
    const currentReward = formatRpow(ledger.current_reward_base_units);
    const nextReward = formatRpow(ledger.next_reward_base_units);
    const nextHalvingAt = formatRpow(ledger.next_halving_at_base_units);
    const toGo = formatRpow(ledger.base_units_to_next_halving);
    // Reward fraction expressed as 1/N. Base reward at halving_index 0 is
    // 1/128 RPOW (= 7,812,500 base units), and halves each tier.
    const baseDenom = 128;
    const rewardFrac = `1/${baseDenom * 2 ** ledger.halving_index}`;
    const nextRewardFrac = ledger.is_capped ? '—' : `1/${baseDenom * 2 ** (ledger.halving_index + 1)}`;
    rewardBlock = `  CURRENT REWARD   : ${currentReward} RPOW (${rewardFrac}) per solution
  CURRENT DIFFICULTY: ${ledger.current_difficulty_bits} trailing zero bits
  NEXT HALVING AT  : ${nextHalvingAt} RPOW total minted (${toGo} RPOW to go)
  NEXT REWARD      : ${ledger.is_capped ? 'CAPPED' : `${nextReward} RPOW (${nextRewardFrac})`}

`;
  }

  return (
    <Panel title="MINE">
      <pre style={{ margin: 0 }}>
{`${rewardBlock}  TARGET           : ${target ?? '--'} trailing zero bits
  HASHES (current) : ${Number(hashes).toLocaleString()}
  RATE             : ${fmtRate()}
  ELAPSED          : ${fmtElapsed()}
  STATUS           : ${status.toUpperCase()}
  MINED THIS RUN   : ${sessionMinted}${lastTokenId ? `\n  LAST TOKEN       : ${lastTokenId}` : ''}${error ? `\n  ERROR            : ${error}` : ''}
`}
      </pre>
      <div style={{ marginTop: 8 }}>
        {running ? (
          <button onClick={stop}>[ STOP ]</button>
        ) : (
          <button onClick={start}>[ MINE ]</button>
        )}
      </div>
    </Panel>
  );
}
