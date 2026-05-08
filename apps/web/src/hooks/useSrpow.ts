import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import type { WrapEvent, WrapResponse } from '@rpow/shared';

export function useSrpow() {
  const [events, setEvents] = useState<WrapEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setEvents(await api.srpowEvents()); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh().catch(() => {}); }, [refresh]);

  async function wrap(amount_base_units: string): Promise<WrapResponse> {
    const idempotency_key = crypto.randomUUID();
    const r = await api.srpowWrap({ amount_base_units, idempotency_key });
    await refresh();
    return r;
  }

  return { events, loading, wrap, refresh };
}
