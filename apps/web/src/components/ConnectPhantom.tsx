import { useState } from 'react';
import { usePhantom } from '../hooks/usePhantom.js';
import { api } from '../api.js';

interface Props {
  boundWallet: string | null;
  onBound(wallet: string): void;
  onDisconnect?(): void;
}

export function ConnectPhantom({ boundWallet, onBound, onDisconnect }: Props) {
  const phantom = usePhantom();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (boundWallet) {
    return (
      <div>
        Phantom: <code>{abbr(boundWallet)}</code>
        {' '}
        <a
          href={`https://solscan.io/account/${boundWallet}`}
          target="_blank"
          rel="noreferrer"
          style={{ color: '#6ee7b7', fontSize: 12 }}
        >
          [view]
        </a>
        {' '}
        <button
          style={{ fontSize: 12 }}
          onClick={async () => {
            try { await phantom.disconnect?.(); } catch {}
            onDisconnect?.();
          }}
        >
          [disconnect]
        </button>
      </div>
    );
  }
  if (!phantom.installed) {
    return (
      <div style={{ color: '#f88' }}>
        Phantom wallet not detected. Install at{' '}
        <a href="https://phantom.app" target="_blank" rel="noreferrer" style={{ color: '#6ee7b7' }}>
          phantom.app
        </a>{' '}
        and reload.
      </div>
    );
  }

  async function handleConnect() {
    setBusy(true); setErr(null);
    try {
      const wallet = await phantom.connect();
      const challenge = await api.phantomChallenge();
      const sig = await phantom.signMessage(challenge.message);
      const bound = await api.phantomBind({
        nonce: challenge.nonce,
        wallet_address: wallet,
        signature_base58: sig,
      });
      onBound(bound.solana_wallet);
    } catch (e: any) {
      setErr(e?.message ?? 'connect failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button disabled={busy} onClick={handleConnect}>
        {busy ? 'Connecting…' : 'Connect Phantom'}
      </button>
      {err && <div style={{ color: '#f88', marginTop: 6, fontSize: 12 }}>{err}</div>}
    </div>
  );
}

function abbr(s: string): string {
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
