import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { AmmWalletProviders } from '../amm/AmmWalletProviders';
import { TermsModal } from '../amm/TermsModal';
import { useWalletLink } from '../amm/useWalletLink';
import { useAmmDeposit } from '../amm/useAmmDeposit';
import {
  getAmmConfig, getWalletStatus, type AmmConfig, type WalletStatus,
} from '../api/amm';
import { api } from '../api.js';

function formatUsdc(base: string | bigint): string {
  const n = typeof base === 'bigint' ? base : BigInt(base);
  return (Number(n) / 1_000_000).toFixed(6);
}

function PageInner() {
  const { publicKey, disconnect } = useWallet();
  const [config, setConfig] = useState<AmmConfig | null>(null);
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [termsAccepted, setTermsAccepted] = useState<boolean | null>(null);  // null = unknown
  const [amount, setAmount] = useState('');
  const [credited, setCredited] = useState<{ amount: bigint; sig: string } | null>(null);
  const [retroInfo, setRetroInfo] = useState<{ count: number; total_base_units: string } | null>(null);

  const { link, busy: linkBusy, error: linkError } = useWalletLink();
  const { deposit, phase, sig, error: depositError, setPhase } = useAmmDeposit(config);

  // Initial load: config + status. Status returns 403 TERMS_NOT_ACCEPTED until accepted.
  useEffect(() => {
    (async () => {
      try { setConfig(await getAmmConfig()); }
      catch { /* show error UI below */ }
      try {
        setStatus(await getWalletStatus());
        setTermsAccepted(true);
      } catch (e: any) {
        if (e.body?.error === 'TERMS_NOT_ACCEPTED') setTermsAccepted(false);
        else throw e;
      }
    })();
  }, []);

  // After successful broadcast, poll /me until balance moves.
  useEffect(() => {
    if (phase !== 'awaiting_credit' || !sig) return;
    const expected = BigInt(Math.floor(parseFloat(amount) * 1_000_000));
    let cancelled = false;
    let elapsed = 0;
    const t = setInterval(async () => {
      elapsed += 4;
      try {
        const me = await api.me();
        const balB = BigInt(me.usdc_base_units ?? 0);
        if (balB >= expected) {
          if (!cancelled) {
            setCredited({ amount: expected, sig });
            setPhase('credited');
            clearInterval(t);
          }
        }
      } catch { /* keep trying */ }
      if (elapsed >= 90) clearInterval(t);
    }, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, [phase, sig, amount, setPhase]);

  if (termsAccepted === false) {
    return <TermsModal onAccepted={async () => {
      try { setStatus(await getWalletStatus()); } catch { /* show error UI below */ }
      setTermsAccepted(true);
    }} />;
  }

  return (
    <div style={{ fontFamily: 'monospace', color: '#cfe', maxWidth: 720, margin: '24px auto', padding: 16 }}>
      <div style={{ background: '#332300', padding: 8, marginBottom: 16, border: '1px solid #6a4a00' }}>
        ⚠ GAME — funds at risk, limited support
      </div>
      <h2>DEPOSIT USDC</h2>

      <div style={{ marginBottom: 12 }}>
        <span>Phantom wallet: </span>
        {publicKey
          ? <><code>{publicKey.toBase58().slice(0,4)}…{publicKey.toBase58().slice(-4)}</code>
              <button onClick={() => disconnect()} style={{ marginLeft: 8 }}>DISCONNECT</button></>
          : <WalletMultiButton />}
      </div>

      <div style={{ marginBottom: 12 }}>
        Linked to this account: {' '}
        {status?.linked_pubkey
          ? <code>{status.linked_pubkey.slice(0,4)}…{status.linked_pubkey.slice(-4)}</code>
          : '—'}
      </div>

      {publicKey && status && !status.linked_pubkey && (
        <div style={{ marginBottom: 16, padding: 12, border: '1px dashed #2c4a40' }}>
          <p>Link this wallet to your RPOW account. One-time, no fee, no transaction sent.</p>
          <button disabled={linkBusy} onClick={async () => {
            const r = await link();
            setStatus({ linked_pubkey: r.linked_pubkey });
            if (r.retro_attributed.count > 0) setRetroInfo(r.retro_attributed);
          }}>
            { linkBusy ? '…' : 'LINK THIS WALLET' }
          </button>
          {linkError && <p style={{ color: '#f88' }}>{linkError}</p>}
        </div>
      )}

      {retroInfo && (
        <div style={{ marginBottom: 16, padding: 12, background: '#0a2218' }}>
          ✓ {retroInfo.count} prior deposit(s) retro-credited: {formatUsdc(retroInfo.total_base_units)} USDC
        </div>
      )}

      {publicKey && status?.linked_pubkey && publicKey.toBase58() === status.linked_pubkey && (
        <div style={{ marginBottom: 16, padding: 12, border: '1px solid #2c4a40' }}>
          <label>Amount to deposit (USDC): {' '}
            <input value={amount} onChange={e => setAmount(e.target.value)} style={{ width: 120 }} />
          </label>
          <button
            disabled={!amount || phase !== 'idle' && phase !== 'credited' && phase !== 'error'}
            style={{ marginLeft: 8 }}
            onClick={() => deposit(BigInt(Math.floor(parseFloat(amount) * 1_000_000)))}
          >
            DEPOSIT {amount ? `${amount} ` : ''}USDC
          </button>
          {phase !== 'idle' && (
            <p>phase: {phase}{sig ? ` (sig: ${sig.slice(0, 8)}…)` : ''}</p>
          )}
          {depositError && <p style={{ color: '#f88' }}>{depositError}</p>}
          {credited && (
            <p style={{ color: '#9eb' }}>
              ✓ Credited {formatUsdc(credited.amount)} USDC — sig {credited.sig.slice(0, 12)}…
            </p>
          )}
        </div>
      )}

      {publicKey && status?.linked_pubkey && publicKey.toBase58() !== status.linked_pubkey && (
        <div style={{ padding: 12, color: '#fa8' }}>
          ⚠ The connected wallet doesn't match the wallet linked to your account.
          Either disconnect and connect the linked one, or unlink first.
        </div>
      )}

      <p style={{ marginTop: 24, fontSize: 13, color: '#aab' }}>
        ⓘ Only Phantom/Solflare are supported. Deposits from exchanges or
        hardware wallets are not auto-credited — contact the operator.
      </p>
    </div>
  );
}

export default function UsdcDeposit() {
  return (
    <AmmWalletProviders>
      <PageInner />
    </AmmWalletProviders>
  );
}
