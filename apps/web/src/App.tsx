import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes, NavLink } from 'react-router-dom';
import { applyTheme, loadTheme, nextTheme, type Theme } from './theme.js';
import { useMe } from './hooks/useMe.js';
import { api } from './api.js';
import { LoginPage } from './pages/Login.js';
import { WalletPage } from './pages/Wallet.js';
import { MinePage } from './pages/Mine.js';
import { SendPage } from './pages/Send.js';
import { ActivityPage } from './pages/Activity.js';
import { LedgerPage } from './pages/Ledger.js';
import { WrapPage } from './pages/WrapPage.js';
import { AppsPage } from './pages/Apps.js';
import { AuthCallbackPage } from './pages/AuthCallback.js';

export default function App() {
  const [theme, setTheme] = useState<Theme>(loadTheme());
  useEffect(() => { applyTheme(theme); }, [theme]);
  const { me } = useMe();

  async function logout() {
    try { await api.logout(); } catch { /* ignore */ }
    window.location.href = '/';
  }

  return (
    <HashRouter>
      <div className="app-shell">
        <header className="app-header">
          <pre style={{ margin: 0 }}>{'+======================================================================+\n|                   RPOW2 - Reusable Proofs of Work                  '}<span onClick={() => setTheme(nextTheme(theme))} title="cycle theme" style={{ cursor: 'pointer', fontSize: 13, color: 'var(--accent)' }}>{'\u25cf'}</span>{' |\n+======================================================================+'}</pre>
          <div className="tagline">a modern tribute to a tribute to the original rpow by hal finney</div>
          {me && (
            <div className="identity-bar" style={{ fontSize: 12, color: 'var(--dim)', marginTop: 4 }}>
              logged in as <strong style={{ color: 'var(--accent)' }}>{me.email}</strong>
              {me.x_handle && <> · <strong style={{ color: 'var(--accent)' }}>@{me.x_handle}</strong></>}
            </div>
          )}
          <nav className="nav">
            <NavLink to="/">wallet</NavLink>
            <NavLink to="/mine">mine</NavLink>
            <NavLink to="/send">send</NavLink>
            <NavLink to="/activity">activity</NavLink>
            <NavLink to="/ledger">ledger</NavLink>
            {me?.wrap_allowed && <NavLink to="/wrap">wrap</NavLink>}
            <NavLink to="/apps">apps</NavLink>
            <a href="https://stats.rpow2.com/" target="_blank" rel="noreferrer" className="external">stats{'\u2197'}</a>
            {me
              ? <button onClick={logout} title="end session">out</button>
              : <NavLink to="/login">login</NavLink>
            }
          </nav>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<WalletPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/mine" element={<MinePage />} />
            <Route path="/send" element={<SendPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/ledger" element={<LedgerPage />} />
            <Route path="/wrap" element={<WrapPage />} />
            <Route path="/apps" element={<AppsPage />} />
            <Route path="/auth-callback" element={<AuthCallbackPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
