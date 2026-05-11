import { useState } from 'react';
import { enterArena, formatRpow } from './api.js';

interface Props {
  balanceBaseUnits: string;
  onEntered: () => void;
}

const MIN_BET = 10_000_000n;            // 0.01 RPOW
const MAX_BET = 10_000_000_000n;        // 10 RPOW
const MAX_BANKROLL = 100_000_000_000n;  // 100 RPOW

export function EnterArenaForm({ balanceBaseUnits, onEntered }: Props) {
  const [bet, setBet] = useState<bigint>(MIN_BET);
  const [bankrollMultiple, setBankrollMultiple] = useState<number>(5); // default: 5 flips worth
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bankroll = bet * BigInt(bankrollMultiple);
  const balance = BigInt(balanceBaseUnits);
  const tooExpensive = bankroll > balance;
  const tooLarge = bankroll > MAX_BANKROLL;

  async function onEnter() {
    setError(null); setBusy(true);
    try {
      await enterArena(bankroll.toString(), bet.toString());
      onEntered();
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <h2>ENTER THE ARENA</h2>
      <p style={{ fontSize: 12, color: '#888' }}>
        Commit a bankroll. Other gladiators flip you one bet at a time until you drain or leave.
      </p>
      <div style={{ marginTop: 12 }}>
        <label>Bet per flip (RPOW):</label>
        <select
          value={bet.toString()}
          onChange={e => setBet(BigInt(e.target.value))}
          disabled={busy}
        >
          <option value={MIN_BET.toString()}>0.01</option>
          <option value={(MIN_BET * 10n).toString()}>0.1</option>
          <option value={(MIN_BET * 100n).toString()}>1</option>
          <option value={MAX_BET.toString()}>10</option>
        </select>
      </div>
      <div style={{ marginTop: 12 }}>
        <label>Bankroll (flips × bet):</label>
        <select
          value={bankrollMultiple.toString()}
          onChange={e => setBankrollMultiple(parseInt(e.target.value, 10))}
          disabled={busy}
        >
          {[1, 2, 5, 10, 25, 50, 100].map(n => (
            <option key={n} value={n}>
              {n} × {formatRpow(bet.toString())} = {formatRpow((bet * BigInt(n)).toString())} RPOW
            </option>
          ))}
        </select>
      </div>
      <div style={{ marginTop: 12, fontSize: 12, color: '#888' }}>
        Your balance: {formatRpow(balanceBaseUnits)} RPOW
      </div>
      <button
        style={{ marginTop: 12 }}
        onClick={onEnter}
        disabled={busy || tooExpensive || tooLarge}
      >
        {busy ? 'entering...' : `[ ENTER ARENA — ${formatRpow(bankroll.toString())} RPOW ]`}
      </button>
      {tooExpensive && <div className="error" style={{marginTop:8}}>not enough balance</div>}
      {tooLarge && <div className="error" style={{marginTop:8}}>bankroll exceeds 100 RPOW cap</div>}
      {error && <div className="error" style={{marginTop:8}}>{error}</div>}
    </div>
  );
}
