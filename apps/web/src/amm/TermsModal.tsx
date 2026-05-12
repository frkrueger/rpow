import { useState } from 'react';
import { postAcceptTerms } from '../api/amm';

const WARNING = `⚠ EXPERIMENTAL GAME. NOT A FINANCIAL PRODUCT.

RPOW Pool is a hobbyist game with an unaudited automated market maker on
top of a tribute token. It is not an exchange, brokerage, or investment
vehicle. Treat it like a video game that happens to involve small
real-world value.

• USDC you deposit may be permanently lost through bugs, operator error,
  key compromise, or any other reason.
• Tech support is limited. There is no help desk. Issues may take days,
  weeks, or never be resolved.
• We take no responsibility for any loss.
• Don't deposit more than you'd spend on a Steam game.
• RPOW is a tribute token to Hal Finney's original, not a security or
  investment.

By proceeding you accept these risks.`;

export function TermsModal({ onAccepted }: { onAccepted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        maxWidth: 640, padding: 24, background: '#0b1110', color: '#cfe',
        border: '1px solid #2c4a40', borderRadius: 6, fontFamily: 'monospace',
      }}>
        <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{WARNING}</pre>
        {err && <p style={{ color: '#f88', marginTop: 12 }}>{err}</p>}
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true); setErr(null);
            try { await postAcceptTerms(); onAccepted(); }
            catch (e: any) { setErr(e.message ?? 'failed'); }
            finally { setBusy(false); }
          }}
          style={{ marginTop: 16, padding: '8px 16px', background: '#1a2c26', color: '#9eb', cursor: 'pointer' }}
        >
          { busy ? '…' : 'I UNDERSTAND, PROCEED' }
        </button>
      </div>
    </div>
  );
}
