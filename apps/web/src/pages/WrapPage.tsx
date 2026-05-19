import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Panel } from '../components/Panel.js';
import { ConnectPhantom } from '../components/ConnectPhantom.js';
import { WrapForm } from '../components/WrapForm.js';
import { WrapHistory } from '../components/WrapHistory.js';
import { UnwrapForm } from '../components/UnwrapForm.js';
import { AmmWalletProviders } from '../amm/AmmWalletProviders.js';
import { useSrpow } from '../hooks/useSrpow.js';
import { useMe } from '../hooks/useMe.js';
import { useSrpowConfig } from '../hooks/useSrpowConfig.js';
import { formatRpow } from '../lib/format.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export function WrapPage() {
  return (
    <AmmWalletProviders>
      <WrapPageInner />
    </AmmWalletProviders>
  );
}

function WrapPageInner() {
  const { me, refresh: refreshMe } = useMe();
  const { events, refresh: refreshEvents } = useSrpow();
  const { config: srpowConfig } = useSrpowConfig();
  const walletAdapter = useWallet();

  const [wallet, setWallet] = useState<string | null>(me?.solana_wallet ?? null);
  const [tab, setTab] = useState<'wrap' | 'unwrap'>('wrap');
  const [srpowBalance, setSrpowBalance] = useState<bigint>(0n);

  useEffect(() => { setWallet(me?.solana_wallet ?? null); }, [me?.solana_wallet]);

  // Fetch SRPOW balance via server endpoint (sidesteps /solana-rpc CORS dup).
  useEffect(() => {
    if (tab !== 'unwrap') return;
    if (!me?.solana_wallet) return;
    let cancelled = false;
    fetch(`${API_BASE}/srpow/balance`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j: { base_units: string }) => { if (!cancelled) setSrpowBalance(BigInt(j.base_units)); })
      .catch(() => { if (!cancelled) setSrpowBalance(0n); });
    return () => { cancelled = true; };
  }, [tab, me?.solana_wallet, events]);

  if (!me) return <Panel title="WRAP TO SOLANA"><div>loading…</div></Panel>;
  if (!me.wrap_allowed) {
    return <Panel title="WRAP TO SOLANA"><div>Not enabled for your account.</div></Panel>;
  }

  const tabBtn = (active: boolean): React.CSSProperties => ({
    fontFamily: 'inherit',
    fontWeight: active ? 700 : 400,
    padding: '4px 12px',
    background: active ? 'var(--accent, #6ee7b7)' : 'transparent',
    color: active ? '#000' : 'inherit',
    border: '1px solid var(--accent, #6ee7b7)',
    cursor: 'pointer',
  });

  return (
    <>
      <Panel title="WRAP / UNWRAP SRPOW">
        <p style={{ marginTop: 0, fontSize: 12, color: '#aaa' }}>
          Centralized ↔ on-chain. Wrap mints SRPOW to your wallet; Unwrap burns
          SRPOW and credits RPOW back. The operator takes no warranty —
          treat with care.
        </p>
        <ConnectPhantom
          boundWallet={wallet}
          onBound={(w) => { setWallet(w); refreshMe(); }}
          onDisconnect={() => { setWallet(null); }}
        />
        <div style={{ marginTop: 8 }}>
          RPOW available: <strong>{formatRpow(me.balance_base_units)}</strong>{' · '}
          SRPOW you've wrapped: <strong>{formatRpow(me.srpow_supply_owned_base_units)}</strong>
        </div>
      </Panel>

      <Panel title={tab === 'wrap' ? 'WRAP' : 'UNWRAP'}>
        <div className="tabbar" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => setTab('wrap')}
            aria-pressed={tab === 'wrap'}
            style={tabBtn(tab === 'wrap')}
          >
            Wrap
          </button>
          <button
            onClick={() => setTab('unwrap')}
            aria-pressed={tab === 'unwrap'}
            style={tabBtn(tab === 'unwrap')}
          >
            Unwrap
          </button>
        </div>
        {tab === 'wrap' ? (
          <WrapForm
            availableBaseUnits={me.balance_base_units}
            enabled={!!wallet}
            onWrapped={() => { refreshEvents(); refreshMe(); }}
          />
        ) : srpowConfig ? (
          <UnwrapForm
            srpowBalanceBaseUnits={srpowBalance}
            config={srpowConfig}
            walletAdapter={walletAdapter.publicKey ? walletAdapter : null}
            onUnwrapped={() => { refreshEvents(); refreshMe(); }}
          />
        ) : (
          <div style={{ fontSize: 12, color: '#888' }}>Loading config…</div>
        )}
      </Panel>

      <Panel title="RECENT ACTIVITY">
        <WrapHistory events={events} />
      </Panel>
    </>
  );
}
