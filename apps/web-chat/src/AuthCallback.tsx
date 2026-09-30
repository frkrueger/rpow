import { useEffect } from 'react';

/** Receives the rpow_session forwarded from rpow2.com via the URL fragment.
 *  Sets a Domain=.rpow2.com cookie (works for chat.rpow2.com only — falls
 *  back to host-only otherwise) and bounces to /.
 *
 *  rpow2.com's "chat↗" link does:
 *    window.location.href = 'https://chat.rpow2.com/#/auth-callback?s=<token>'
 *
 *  Because the SPA uses BrowserRouter, the `#/auth-callback?s=...` lands as
 *  a hash fragment. We parse it ourselves rather than relying on the router. */
export function AuthCallback() {
  useEffect(() => {
    const hash = window.location.hash; // "#/auth-callback?s=<token>"
    const qIndex = hash.indexOf('?');
    const params = qIndex >= 0 ? new URLSearchParams(hash.slice(qIndex + 1)) : new URLSearchParams();
    const token = params.get('s');
    if (token) {
      const host = window.location.hostname;
      const domain = host.endsWith('.rpow2.com') ? '; Domain=.rpow2.com' : '';
      const secure = window.location.protocol === 'https:' ? '; Secure' : '';
      // 30-day expiry mirrors the server-set session cookie's TTL.
      const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toUTCString();
      document.cookie = `rpow_session=${token}; Path=/${domain}; SameSite=Lax${secure}; Expires=${expires}`;
    }
    // Strip the fragment + bounce to the room directory.
    window.history.replaceState(null, '', '/');
    window.location.replace('/');
  }, []);

  return (
    <div className="enter-body">
      <p>Signing you in…</p>
    </div>
  );
}
