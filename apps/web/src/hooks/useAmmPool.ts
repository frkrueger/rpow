import { useEffect, useState, useCallback, useRef } from 'react';
import { api, type AmmPoolResponse } from '../api.js';

const POLL_INTERVAL_MS = 10_000;

/**
 * Polls `GET /amm/pool` every 10s while mounted. Returns the latest pool
 * snapshot, a manual `refresh()`, and loading/error state.
 *
 * Errors are surfaced so callers can render a degraded state instead of
 * a blank page. `pool` is `null` only on the initial fetch.
 */
export function useAmmPool(): {
  pool: AmmPoolResponse | null;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
} {
  const [pool, setPool] = useState<AmmPoolResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const p = await api.amm.pool();
      if (mounted.current) {
        setPool(p);
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
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  return { pool, loading, error, refresh };
}
