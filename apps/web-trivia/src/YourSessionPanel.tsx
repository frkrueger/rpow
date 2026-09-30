import { useState } from 'react';
import { closeSession, formatRpow, type SessionRow } from './api.js';

interface Props {
  session: SessionRow;
  onClosed: () => void;
}

export function YourSessionPanel({ session, onClosed }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onLeave() {
    setError(null); setBusy(true);
    try {
      await closeSession(session.id);
      onClosed();
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  const remaining = BigInt(session.bankroll_remaining_base_units);
  const bet = BigInt(session.bet_base_units);
  const matchesRemaining = bet > 0n ? remaining / bet : 0n;

  return (
    <div className="panel">
      <h2>YOUR SESSION</h2>
      <div style={{ marginTop: 8 }}>
        Bankroll: <strong>{formatRpow(session.bankroll_remaining_base_units)} RPOW</strong> ({matchesRemaining.toString()} matches at {formatRpow(session.bet_base_units)} RPOW each)
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: '#aaa' }}>
        W/L this session: <strong>{session.matches_won}</strong> / <strong>{session.matches_lost}</strong>
      </div>
      <button
        style={{ marginTop: 12 }}
        onClick={onLeave}
        disabled={busy}
      >
        {busy ? 'leaving...' : '[ LEAVE ARENA ]'}
      </button>
      {error && <div className="error" style={{marginTop:8}}>{error}</div>}
    </div>
  );
}
