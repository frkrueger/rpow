import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const SESSION_TTL = 2592000; // 30 days — matches the AuthCallback on rpow2.com

// Forwarded-session handshake. When someone clicks RPOW Gladiator from
// rpow2.com's /apps with forwardSession=true, the URL arrives as
// https://gladiator.rpow2.com/#/auth-callback?s=<token>. Set the .rpow2.com
// cookie on this origin before React mounts so the very first fetchMe sees
// the session. Strip the fragment afterwards so refreshes don't replay.
(function maybeAdoptForwardedSession() {
  const m = window.location.hash.match(/[?&]s=([^&]+)/);
  if (!m) return;
  const token = decodeURIComponent(m[1]);
  document.cookie = `rpow_session=${token}; Path=/; Max-Age=${SESSION_TTL}; SameSite=Lax; Domain=.rpow2.com; Secure`;
  history.replaceState(null, '', window.location.pathname + window.location.search);
})();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
