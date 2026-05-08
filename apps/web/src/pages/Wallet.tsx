import { Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { useMe } from '../hooks/useMe.js';
import { api } from '../api.js';
import { formatRpow } from '../lib/format.js';

export function WalletPage() {
  const { me, loading, refresh } = useMe();
  if (loading) return <Panel><div>loading...</div></Panel>;
  if (!me) return (
    <Panel title="WALLET">
      <div>not signed in.</div>
      <div style={{ marginTop: 8 }}>
        <Link to="/login">[ go to login ]</Link>
      </div>
    </Panel>
  );

  async function logout() {
    await api.logout();
    await refresh();
  }

  return (
    <Panel title="WALLET">
      <pre style={{ margin: 0 }}>
{`  > LOGGED IN AS: ${me.email}
  > BALANCE     : ${formatRpow(me.balance_base_units)} RPOW
  > MINTED      : ${formatRpow(me.minted_base_units)}
  > SENT        : ${formatRpow(me.sent_base_units)}
  > RECEIVED    : ${formatRpow(me.received_base_units)}
`}
      </pre>
      <div style={{ marginTop: 8 }}>
        <Link to="/mine">[ MINE ]</Link>{' '}
        <Link to="/send">[ SEND ]</Link>{' '}
        <Link to="/activity">[ ACTIVITY ]</Link>{' '}
        <button onClick={logout}>[ LOGOUT ]</button>
      </div>
    </Panel>
  );
}
