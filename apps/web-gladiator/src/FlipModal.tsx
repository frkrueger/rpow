import { useState } from 'react';
import { flipAgainst, formatRpow, type LobbyEntry, type FlipResponse } from './api.js';

interface Props {
  target: LobbyEntry;
  challengerEmail: string;
  challengerHandle: string;
  onClose: () => void;
  onFlipped: () => void;
}

export function FlipModal({ target, challengerEmail, challengerHandle, onClose, onFlipped }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FlipResponse | null>(null);

  async function onConfirm() {
    setError(null); setBusy(true);
    try {
      const r = await flipAgainst(target.session_id);
      setResult(r);
      onFlipped(); // refresh parent state (balance, lobby, recent flips)
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  // Confirm step
  if (!result) {
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
          <button onClick={onConfirm} disabled={busy}>
            {busy ? 'flipping...' : `[ FLIP — ${formatRpow(target.bet_base_units)} RPOW ]`}
          </button>
          <button onClick={onClose} disabled={busy} style={{ marginLeft: 8 }}>
            back
          </button>
          {error && <div className="error" style={{marginTop:8}}>{error}</div>}
        </div>
      </div>
    );
  }

  // Result step
  const youWon = result.winner_email === challengerEmail;
  const payout = formatRpow((BigInt(result.bet_base_units) * 2n).toString());
  const tweetHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(result.share_text)}`;

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2 style={{ color: youWon ? 'var(--accent)' : '#c66' }}>
          {youWon ? `YOU WON ${payout} RPOW` : `YOU LOST ${formatRpow(result.bet_base_units)} RPOW`}
        </h2>
        <p style={{ fontSize: 12, color: '#888' }}>
          {youWon
            ? `You beat @${target.x_handle}. Tokens minted to your balance.`
            : `@${target.x_handle} won the flip. Your stake is gone.`}
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
            [ TWEET THIS ]
          </a>
        )}
        <button onClick={onClose} style={{ marginTop: 16, display: 'block' }}>
          close
        </button>
      </div>
    </div>
  );
}
