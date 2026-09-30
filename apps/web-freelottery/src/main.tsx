import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const SESSION_TTL = 2592000; // 30 days

(function maybeAdoptForwardedSession() {
  const m = window.location.hash.match(/[?&]s=([^&]+)/);
  if (!m) return;
  const token = decodeURIComponent(m[1]);
  document.cookie = `rpow_session=${token}; Path=/; Max-Age=${SESSION_TTL}; SameSite=Lax; Domain=.rpow2.com; Secure`;
  history.replaceState(null, '', window.location.pathname + window.location.search);
})();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
