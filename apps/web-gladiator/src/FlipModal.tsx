import { useEffect, useRef, useState } from 'react';
import { flipAgainst, formatRpow, type LobbyEntry, type FlipResponse } from './api.js';

interface Props {
  target: LobbyEntry;
  challengerEmail: string;
  challengerHandle: string;
  onClose: () => void;
  onFlipped: () => void;
}

type Stage = 'confirm' | 'rolling' | 'result';

const ROLL_MS = 1800;
const ROLL_TICK_MS = 60;

export function FlipModal({ target, challengerEmail, challengerHandle, onClose, onFlipped }: Props) {
  const [stage, setStage] = useState<Stage>('confirm');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FlipResponse | null>(null);
  const [rollByte, setRollByte] = useState<string>('00');
  const [rollHistory, setRollHistory] = useState<string[]>([]);
  const rollStartRef = useRef<number>(0);

  async function onConfirm() {
    setError(null);
    setStage('rolling');
    rollStartRef.current = performance.now();
    try {
      const r = await flipAgainst(target.session_id);
      // Hold in 'rolling' state at least ROLL_MS so the animation actually
      // reads as drama, even if the server is instantaneous. The real signed
      // outcome gets revealed at the end.
      const elapsed = performance.now() - rollStartRef.current;
      const remaining = Math.max(0, ROLL_MS - elapsed);
      setTimeout(() => {
        setResult(r);
        setStage('result');
        onFlipped();
      }, remaining);
    } catch (e: any) {
      setError(e.message);
      setStage('confirm');
    }
  }

  // While 'rolling', cycle random hex bytes so the user sees the wheel spin.
  // We do NOT use the server result here — the final reveal swaps to it.
  useEffect(() => {
    if (stage !== 'rolling') return;
    const t = setInterval(() => {
      const b = Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
      setRollByte(b);
      setRollHistory(h => [b, ...h].slice(0, 8));
    }, ROLL_TICK_MS);
    return () => clearInterval(t);
  }, [stage]);

  // Confirm step
  if (stage === 'confirm') {
    return (
      <div className="modal-backdrop">
        <div className="modal">
          <h2>FLIP <a href={`https://x.com/${target.x_handle}`} target="_blank" rel="noreferrer noopener" className="x-handle">@{target.x_handle}</a></h2>
          <p>
            Stake: <strong>{formatRpow(target.bet_base_units)} RPOW</strong>
          </p>
          <p style={{ fontSize: 12, color: '#888' }}>
            50/50 fair coin. Winner takes 2× the bet. Outcome is server-signed.
          </p>
          <button onClick={onConfirm}>
            {`[ FLIP — ${formatRpow(target.bet_base_units)} RPOW ]`}
          </button>
          <button onClick={onClose} style={{ marginLeft: 8 }}>
            back
          </button>
          {error && <div className="error" style={{marginTop:8}}>{error}</div>}
        </div>
      </div>
    );
  }

  // Rolling step — terminal-style byte cycler. The final byte (LSB) decides.
  if (stage === 'rolling') {
    return (
      <div className="modal-backdrop">
        <div className="modal flip-rolling">
          <h2 style={{ marginBottom: 8 }}>FLIPPING…</h2>
          <p style={{ fontSize: 12, color: '#888', marginTop: 0 }}>
            drawing a random byte from <code>crypto.randomBytes(1)</code>
          </p>
          <div className="flip-byte" aria-live="polite">{rollByte}</div>
          <div className="flip-history">
            {rollHistory.map((h, i) => (
              <span key={i} style={{ opacity: 1 - i * 0.12 }}>{h}</span>
            ))}
          </div>
          <p style={{ fontSize: 11, color: '#666', marginTop: 16 }}>
            stake: {formatRpow(target.bet_base_units)} RPOW · payout on win: {formatRpow((BigInt(target.bet_base_units) * 2n).toString())} RPOW
          </p>
        </div>
      </div>
    );
  }

  // Result step
  if (!result) return null;
  const youWon = result.winner_email === challengerEmail;
  const payout = formatRpow((BigInt(result.bet_base_units) * 2n).toString());
  const tweetHref = `https://x.com/intent/post?text=${encodeURIComponent(result.share_text)}`;

  return (
    <div className="modal-backdrop">
      <div className={`modal flip-result ${youWon ? 'flip-win' : 'flip-lose'}`}>
        <div className="flip-byte-final" aria-label="final RNG byte">
          {result.random_value_hex}
        </div>
        <h2 style={{ color: youWon ? 'var(--accent)' : '#e07a7a', marginTop: 0 }}>
          {youWon ? `YOU WON ${payout} RPOW` : `YOU LOST ${formatRpow(result.bet_base_units)} RPOW`}
        </h2>
        <p style={{ fontSize: 12, color: '#aaa' }}>
          {youWon
            ? <>You beat <a href={`https://x.com/${target.x_handle}`} target="_blank" rel="noreferrer noopener" className="x-handle">@{target.x_handle}</a>. Tokens minted to your balance.</>
            : <><a href={`https://x.com/${target.x_handle}`} target="_blank" rel="noreferrer noopener" className="x-handle">@{target.x_handle}</a> won the flip. Your stake is gone.</>}
        </p>
        <div style={{ marginTop: 12, fontSize: 11, color: '#666' }}>
          rv: {result.random_value_hex} · sig: {result.signature.slice(0, 16)}… · {new Date(result.server_time).toLocaleTimeString()}
        </div>
        {youWon && (
          <a
            href={tweetHref}
            target="_blank"
            rel="noreferrer"
            style={{ display: 'inline-block', marginTop: 16 }}
          >
            [ POST TO X ]
          </a>
        )}
        <button onClick={onClose} style={{ marginTop: 16, display: 'block' }}>
          close
        </button>
      </div>
    </div>
  );
}
