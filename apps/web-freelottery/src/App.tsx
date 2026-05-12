import { useEffect, useState } from 'react';

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

interface Status {
  enabled: boolean;
  startUtcDate: string | null;
  totalDays: number;
  prizeBaseUnits: string;
  drawHourUtc: number;
  dayIndex: number | null;
  nextDrawAt: string | null;
  ended: boolean;
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/freelottery/status`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setStatus)
      .catch(e => setError(String(e)));
  }, []);

  return (
    <main>
      <h1>RPOW Free Lottery</h1>
      <p>Coming soon — 100 days of 1,000 RPOW giveaways.</p>
      {error ? <pre className="error">{error}</pre> : null}
      {status ? <pre>{JSON.stringify(status, null, 2)}</pre> : null}
    </main>
  );
}
