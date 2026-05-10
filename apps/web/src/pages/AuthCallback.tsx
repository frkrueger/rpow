import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const SESSION_TTL = 2592000; // 30 days

export function AuthCallbackPage() {
  const nav = useNavigate();

  useEffect(() => {
    const hash = window.location.hash;
    const match = hash.match(/[?&]s=([^&]+)/);
    const token = match ? decodeURIComponent(match[1]) : null;
    if (token) {
      document.cookie = `rpow_session=${token}; Path=/; Max-Age=${SESSION_TTL}; SameSite=Lax; Domain=.rpow2.com; Secure`;
      window.location.replace('/#/');
    } else {
      nav('/login', { replace: true });
    }
  }, [nav]);

  return <div>signing in...</div>;
}
