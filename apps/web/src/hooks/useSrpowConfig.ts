import { useEffect, useState } from 'react';

export interface SrpowConfig {
  bridge_wallet_pubkey: string;
  srpow_mint_address: string;
  fee_bps: number;
  min_unwrap_base_units: string;
  max_unwrap_base_units: string;
  slippage_bps: number;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export function useSrpowConfig(): { config: SrpowConfig | null; error: string | null } {
  const [config, setConfig] = useState<SrpowConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/srpow/config`, { credentials: 'include' });
        if (!r.ok) throw new Error(`srpow config: ${r.status}`);
        const j = await r.json();
        if (!cancelled) setConfig(j);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return { config, error };
}
