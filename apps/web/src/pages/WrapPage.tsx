import { useEffect, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { ConnectPhantom } from '../components/ConnectPhantom.js';
import { WrapForm } from '../components/WrapForm.js';
import { WrapHistory } from '../components/WrapHistory.js';
import { useSrpow } from '../hooks/useSrpow.js';
import { useMe } from '../hooks/useMe.js';
import { formatRpow } from '../lib/format.js';

export function WrapPage() {
  const { me, refresh: refreshMe } = useMe();
  const { events, refresh: refreshEvents } = useSrpow();
  const [wallet, setWallet] = useState<string | null>(me?.solana_wallet ?? null);
  useEffect(() => { setWallet(me?.solana_wallet ?? null); }, [me?.solana_wallet]);

  if (!me) return <Panel title="WRAP TO SOLANA"><div>loading…</div></Panel>;
  if (!me.wrap_allowed) {
    return <Panel title="WRAP TO SOLANA"><div>Not enabled for your account.</div></Panel>;
  }

  return (
    <>
      <Panel title="WRAP TO SOLANA (SRPOW)">
        <p style={{ marginTop: 0, fontSize: 12, color: '#aaa' }}>
          Centralized → on-chain. Once SRPOW is minted to your wallet, you control it
          via Phantom. The operator takes no fee and no warranty is provided. Treat
          with care.
        </p>
        <ConnectPhantom boundWallet={wallet} onBound={(w) => { setWallet(w); refreshMe(); }} />
        <div style={{ marginTop: 8 }}>
          RPOW available: <strong>{formatRpow(me.balance_base_units)}</strong>{' · '}
          SRPOW you've wrapped: <strong>{formatRpow(me.srpow_supply_owned_base_units)}</strong>
        </div>
      </Panel>

      <Panel title="WRAP">
        <WrapForm
          availableBaseUnits={me.balance_base_units}
          enabled={!!wallet}
          onWrapped={() => { refreshEvents(); refreshMe(); }}
        />
      </Panel>

      <Panel title="RECENT WRAPS">
        <WrapHistory events={events} />
      </Panel>
    </>
  );
}
