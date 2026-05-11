import { useEffect, useState, useCallback, useRef } from 'react';
import { api, type AmmMeResponse } from '../api.js';

/**
 * Fetches `GET /amm/me` once on mount and on demand via `refresh()`. Used
 * by AMM pages for USDC balance, LP balance, and terms acceptance status.
 *
 * Errors are surfaced (e.g. 401 unauthorized, 403 NOT_ALLOWED when the
 * user isn't on the AMM allowlist) so callers can render the right empty
 * state.
 */
export function useAmmMe(): {
  ammMe: AmmMeResponse | null;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
} {
  const [ammMe, setAmmMe] = useState<AmmMeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const m = await api.amm.me();
      if (mounted.current) {
        setAmmMe(m);
        setError(null);
      }
    } catch (err) {
      if (mounted.current) setError(err);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  return { ammMe, loading, error, refresh };
}
