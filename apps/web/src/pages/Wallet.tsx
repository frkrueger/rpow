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
    <Panel title="WALLET" status={me.email}>
      <div className="stat-grid">
        <div className="stat-cell full">
          <div className="stat-label">BALANCE</div>
          <div className="stat-value highlight">{formatRpow(me.balance_base_units)} RPOW</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">MINTED</div>
          <div className="stat-value">{formatRpow(me.minted_base_units)}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">RECEIVED</div>
          <div className="stat-value">{formatRpow(me.received_base_units)}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">SENT</div>
          <div className="stat-value">{formatRpow(me.sent_base_units)}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">DAILY REMAINING</div>
          <div className="stat-value">{me.daily_remaining_base_units ? formatRpow(me.daily_remaining_base_units) : '—'}</div>
        </div>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 6 }}>
        <Link to="/mine"><button className="primary">[ MINE ]</button></Link>
        <Link to="/send"><button>[ SEND ]</button></Link>
        <Link to="/activity"><button>[ ACTIVITY ]</button></Link>
        <button onClick={logout}>[ LOGOUT ]</button>
      </div>
    </Panel>
  );
}
