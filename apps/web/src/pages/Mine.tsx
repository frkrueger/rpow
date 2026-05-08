import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { useMe } from '../hooks/useMe.js';
import { api } from '../api.js';

type Status = 'idle' | 'mining' | 'submitting' | 'success' | 'error';

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
  const [autoMine, setAutoMine] = useState(true);
  const [intensity, setIntensity] = useState(100);
  const [mintMoment, setMintMoment] = useState('');
  const workerRef = useRef<Worker | null>(null);
  // Use a ref (not state) so the async worker callback always sees the latest value
  // without restarting the loop closure.
  const stopRequestedRef = useRef(false);
  const autoMineRef = useRef(autoMine);
  const intensityRef = useRef(intensity);

  useEffect(() => () => {
    stopRequestedRef.current = true;
    workerRef.current?.terminate();
  }, []);
  useEffect(() => { autoMineRef.current = autoMine; }, [autoMine]);
  useEffect(() => { intensityRef.current = intensity; }, [intensity]);

  function sleep(ms: number) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  function cooldownForIntensity() {
    if (intensityRef.current >= 100) return 0;
    if (intensityRef.current >= 75) return 500;
    if (intensityRef.current >= 50) return 1500;
    return 3000;
  }

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
          setMintMoment(`+ MINTED 1 RPOW -> ${r.token.id}`);
          setSessionMinted(n => n + 1);
          await refresh();
          // Loop: kick off the next challenge unless the user asked to stop.
          if (!stopRequestedRef.current && autoMineRef.current) {
            const cooldown = cooldownForIntensity();
            if (cooldown) await sleep(cooldown);
          }
          if (!stopRequestedRef.current && autoMineRef.current) {
            startOne();
          } else {
            setStatus('success');
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
    setMintMoment('');
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
  function ratePerSecond() {
    if (!elapsed) return 0;
    return Number(hashes) / (elapsed / 1000);
  }
  function fmtElapsed() {
    const s = Math.floor(elapsed / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `00:${mm}:${ss}`;
  }
  function fmtDuration(ms: number) {
    if (!Number.isFinite(ms) || ms <= 0) return '--';
    const total = Math.ceil(ms / 1000);
    const hh = String(Math.floor(total / 3600)).padStart(2, '0');
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  function fmtEta() {
    if (target == null) return '--';
    const rate = ratePerSecond();
    if (!rate) return 'waiting for rate';
    const expectedHashes = 2 ** target;
    return fmtDuration((expectedHashes / rate) * 1000);
  }

  if (loading) return <Panel><div>loading...</div></Panel>;
  if (!me) return <Panel title="MINE"><div>not signed in.</div></Panel>;

  const running = status === 'mining' || status === 'submitting';

  return (
    <Panel title="MINE">
      <pre style={{ margin: 0 }}>
{`  TARGET           : ${target ?? '--'} trailing zero bits
  HASHES (current) : ${Number(hashes).toLocaleString()}
  RATE             : ${fmtRate()}
  ETA              : ${fmtEta()}
  ELAPSED          : ${fmtElapsed()}
  STATUS           : ${status.toUpperCase()}
  MINED THIS RUN   : ${sessionMinted}${lastTokenId ? `\n  LAST TOKEN       : ${lastTokenId}` : ''}${mintMoment ? `\n  SUCCESS          : ${mintMoment}` : ''}${error ? `\n  ERROR            : ${error}` : ''}
`}
      </pre>
      <div className="controls" style={{ marginTop: 8 }}>
        <label>
          <input
            type="checkbox"
            checked={autoMine}
            onChange={e => setAutoMine(e.target.checked)}
            disabled={running}
          /> auto-mine
        </label>
        <label>
          CPU intensity
          <select value={intensity} onChange={e => setIntensity(Number(e.target.value))} disabled={running}>
            <option value={100}>100%</option>
            <option value={75}>75%</option>
            <option value={50}>50%</option>
            <option value={25}>25%</option>
          </select>
        </label>
        {running ? (
          <button onClick={stop}>[ PAUSE ]</button>
        ) : (
          <button onClick={start}>[ MINE ]</button>
        )}
      </div>
      <div className="tagline" style={{ marginTop: 8 }}>
        one browser worker; intensity adds a rest between automatic rounds.
      </div>
    </Panel>
  );
}
