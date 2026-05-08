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

const HEADER = [
  '+======================================================================+',
  '|                   RPOW2 - Reusable Proofs of Work                    |',
  '+======================================================================+',
].join('\n');

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
        <header>
          <pre style={{ margin: 0 }}>{HEADER}</pre>
          <div className="tagline">a modern tribute to a tribute to the original rpow by hal finney</div>
          <nav style={{ marginTop: 8 }}>
            <NavLink to="/">[ wallet ]</NavLink>{' '}
            <NavLink to="/mine">[ mine ]</NavLink>{' '}
            <NavLink to="/send">[ send ]</NavLink>{' '}
            <NavLink to="/activity">[ activity ]</NavLink>{' '}
            <NavLink to="/ledger">[ ledger ]</NavLink>{' '}
            {me?.wrap_allowed && (<><NavLink to="/wrap">[ wrap ]</NavLink>{' '}</>)}
            {me ? (
              <button onClick={logout} title="end session">[ logout ]</button>
            ) : (
              <NavLink to="/login">[ login ]</NavLink>
            )}
            {' · '}
            <button onClick={() => setTheme(nextTheme(theme))} title="cycle theme">[ theme: {theme} ]</button>
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
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
