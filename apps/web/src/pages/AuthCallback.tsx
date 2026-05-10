import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

const SESSION_TTL = 2592000; // 30 days

export function AuthCallbackPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();

  useEffect(() => {
    const token = params.get('s');
    if (token) {
      document.cookie = `rpow_session=${token}; Path=/; Max-Age=${SESSION_TTL}; SameSite=Lax; Domain=.rpow2.com; Secure`;
      nav('/', { replace: true });
      window.location.reload();
    } else {
      nav('/login', { replace: true });
    }
  }, [params, nav]);

  return <div>signing in...</div>;
}
