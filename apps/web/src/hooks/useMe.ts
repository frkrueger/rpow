import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { MeResponse } from '@rpow/shared';

export function useMe(): { me: MeResponse | null; loading: boolean; refresh: () => Promise<void> } {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    setLoading(true);
    try {
      setMe(await api.me());
    } catch {
      // Clear any stale cookies that cause 401 — old HttpOnly cookies
      // from previous auth flows can't be cleared by JS alone.
      await api.logout().catch(() => {});
      document.cookie = 'rpow_session=; Path=/; Max-Age=0';
      document.cookie = 'rpow_session=; Path=/; Max-Age=0; Domain=.rpow2.com';
      setMe(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); }, []);
  return { me, loading, refresh };
}
