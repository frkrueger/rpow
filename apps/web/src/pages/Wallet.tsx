import { Link } from 'react-router-dom';
import { Panel } from '../components/Panel.js';
import { useMe } from '../hooks/useMe.js';
import { api } from '../api.js';

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
  > BALANCE     : ${String(me.balance).padStart(4, '0')} RPOW
  > MINTED      : ${String(me.minted).padStart(4, '0')}
  > SENT        : ${String(me.sent).padStart(4, '0')}
  > RECEIVED    : ${String(me.received).padStart(4, '0')}
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
