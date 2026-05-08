import { useState } from 'react';
import { useSrpow } from '../hooks/useSrpow.js';
import { formatRpow, parseRpowToBaseUnits } from '../lib/format.js';

interface Props {
  availableBaseUnits: string;
  enabled: boolean;
  onWrapped(): void;
}

export function WrapForm({ availableBaseUnits, enabled, onWrapped }: Props) {
  const { wrap } = useSrpow();
  const [amount, setAmount] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const availableDisplay = formatRpow(availableBaseUnits);

  async function handle() {
    setBusy(true); setMsg(null);
    try {
      let amount_base_units: string;
      try {
        amount_base_units = parseRpowToBaseUnits(amount);
      } catch {
        throw new Error('amount must be a positive decimal (max 9 places)');
      }
      if (BigInt(amount_base_units) <= 0n) throw new Error('amount must be > 0');
      if (BigInt(amount_base_units) > BigInt(availableBaseUnits)) throw new Error('insufficient balance');
      const r = await wrap(amount_base_units);
      const sigSnippet = r.solana_signature ? `${r.solana_signature.slice(0, 8)}…` : '(no tx)';
      setMsg({ kind: 'ok', text: `Wrapped ${formatRpow(amount_base_units)} RPOW. tx: ${sigSnippet}` });
      setAmount('');
      onWrapped();
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'wrap failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label>Amount to wrap: </label>
      <input
        type="text"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        disabled={!enabled || busy}
      />{' '}
      <button onClick={handle} disabled={!enabled || busy || !amount}>
        {busy ? 'Confirming on Solana…' : 'Wrap'}
      </button>
      <div style={{ marginTop: 4, fontSize: 12, color: '#888' }}>
        available: {availableDisplay} RPOW
      </div>
      {msg && (
        <div style={{ marginTop: 8, color: msg.kind === 'ok' ? '#6ee7b7' : '#f88' }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
