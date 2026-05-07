import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes, NavLink } from 'react-router-dom';
import { applyTheme, loadTheme, nextTheme, type Theme } from './theme.js';

export default function App() {
  const [theme, setTheme] = useState<Theme>(loadTheme());
  useEffect(() => { applyTheme(theme); }, [theme]);

  return (
    <HashRouter>
      <div className="app-shell">
        <header>
          <pre>+======================================================================+
|  RPOW2 - Reusable Proofs of Work                            v0.1.0  |
+======================================================================+</pre>
          <div className="tagline">a tribute to the original rpow by hal finney</div>
          <nav style={{ marginTop: 8 }}>
            <NavLink to="/">[ wallet ]</NavLink>{' '}
            <NavLink to="/mine">[ mine ]</NavLink>{' '}
            <NavLink to="/send">[ send ]</NavLink>{' '}
            <NavLink to="/activity">[ activity ]</NavLink>{' '}
            <NavLink to="/ledger">[ ledger ]</NavLink>{' '}
            <NavLink to="/login">[ login ]</NavLink>{' · '}
            <button onClick={() => setTheme(nextTheme(theme))} title="cycle theme">[ theme: {theme} ]</button>
          </nav>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<div>(wallet placeholder)</div>} />
            <Route path="/login" element={<div>(login placeholder)</div>} />
            <Route path="/mine" element={<div>(mine placeholder)</div>} />
            <Route path="/send" element={<div>(send placeholder)</div>} />
            <Route path="/activity" element={<div>(activity placeholder)</div>} />
            <Route path="/ledger" element={<div>(ledger placeholder)</div>} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
