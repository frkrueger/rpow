import { useEffect, useState } from 'react';
import { fetchMe, fetchAccess, spin, fetchHistory, formatRpow, type Me, type SpinResponse, type HistoryRow } from './api.js';
import { ODDS_TIERS, type OddsChoice, payoutMultipleFor, winProbabilityFor } from './odds.js';
import { playSpin, playWin, playLose, isMuted, toggleMute } from './sound.js';

const MIN_BASE_UNITS = 10_000_000n;     // 0.01 RPOW
const MAX_BASE_UNITS = 1_000_000_000n;  // 1.0 RPOW
const STEP = 10_000_000n;               // 0.01 RPOW

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [access, setAccess] = useState<'allowed' | 'denied' | 'unauthenticated' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stake, setStake] = useState<bigint>(MIN_BASE_UNITS);
  const [odds, setOdds] = useState<OddsChoice>('1:1');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<SpinResponse | null>(null);
  const [muted, setMuted] = useState(isMuted());
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown(c => { if (c <= 1) { clearInterval(t); return 0; } return c - 1; }), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  useEffect(() => {
    fetchMe().then(setMe).catch(e => setError(String(e)));
    fetchAccess().then(setAccess).catch(() => setAccess('denied'));
    fetchHistory().then(setHistory);
  }, []);

  async function takeShot() {
    if (!me) return;
    setBusy(true);
    setLast(null);
    playSpin();
    try {
      const r = await spin(stake.toString(), odds);
      setLast(r);
      setMe({ ...me, balance_base_units: r.new_balance_base_units });
      fetchHistory().then(setHistory);
      if (r.outcome === 'WIN') playWin(); else playLose();
    } catch (e: any) {
      if (e.message === 'Too Many Requests' || e.message === 'TOO_MANY') {
        setCooldown(60);
      } else {
        setError(e.message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (error) return <main><p style={{ color: 'var(--warn)' }}>error: {error}</p></main>;
  if (!me) return <main><p>not signed in. <a href="https://rpow2.com" style={{ color: 'var(--accent)' }}>sign in at rpow2.com</a> and return.</p></main>;
  if (access === 'denied') return (
    <main>
      <h1>RPOW Long Shot</h1>
      <p>Early access — RPOW Long Shot is currently limited to a small allowlist while we validate behavior. Coming soon to all rpow accounts.</p>
      <p style={{ color: 'var(--dim)', fontSize: '.86rem' }}>signed in as {me.email}</p>
    </main>
  );

  const p = winProbabilityFor(odds);
  const m = payoutMultipleFor(odds);
  const stakeRpow = formatRpow(stake.toString());
  const winPayoutRpow = formatRpow((stake * BigInt(m)).toString());

  return (
    <main>
      <button
        className="mute"
        onClick={() => setMuted(toggleMute())}
        title={muted ? 'unmute' : 'mute'}
        aria-label={muted ? 'unmute' : 'mute'}
      >{muted ? '🔇' : '🔊'}</button>
      <h1>RPOW Long Shot</h1>
      <p>balance: <strong>{formatRpow(me.balance_base_units)} RPOW</strong></p>

      <section className="card">
        <label className="row">
          <span>stake:</span>
          <strong>{stakeRpow} RPOW</strong>
        </label>
        <input
          type="range"
          min={MIN_BASE_UNITS.toString()}
          max={MAX_BASE_UNITS.toString()}
          step={STEP.toString()}
          value={stake.toString()}
          onChange={(e) => setStake(BigInt(e.target.value))}
          disabled={busy}
        />

        <div className="pills">
          {ODDS_TIERS.map((t) => (
            <button
              key={t}
              className={`pill ${odds === t ? 'active' : ''}`}
              onClick={() => setOdds(t)}
              disabled={busy}
            >{t}</button>
          ))}
        </div>

        <p className="hint">
          win probability: <strong>{(p * 100).toFixed(2)}%</strong> · payout if win:
          <strong> +{winPayoutRpow} RPOW</strong>
        </p>

        <button className="primary" onClick={takeShot} disabled={busy || cooldown > 0 || stake > BigInt(me.balance_base_units)}>
          {busy ? 'spinning…' : cooldown > 0 ? `wait ${cooldown}s` : 'TAKE THE SHOT'}
        </button>

        {last && (
          <p className={`result ${last.outcome.toLowerCase()}`}>
            {last.outcome === 'WIN' ? `WIN +${formatRpow(last.net_user_change_base_units)}` : `LOSE ${formatRpow(last.net_user_change_base_units)}`} RPOW
          </p>
        )}
      </section>

      {history.length > 0 && (
        <section className="history">
          <h2>last 20 spins</h2>
          <ul>
            {history.map(h => (
              <li key={h.id} className={h.outcome.toLowerCase()}>
                <span className="when">{new Date(h.created_at).toLocaleTimeString()}</span>
                <span className="odds">{h.odds_choice}</span>
                <span className="stake">{formatRpow(h.stake_base_units)}</span>
                <span className="outcome">{h.outcome}</span>
                <span className="delta">
                  {BigInt(h.net_user_change_base_units) > 0n ? '+' : ''}
                  {formatRpow(h.net_user_change_base_units)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="footnote">
        Outcomes generated by server-side <code>crypto.randomBytes()</code>. House edge: 5%. Provably-fair upgrade in Phase 2.
      </p>
    </main>
  );
}
