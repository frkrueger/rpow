import { useEffect, useState } from 'react';
import { Enter } from './Enter.js';
import { api, FreelotteryStatus } from './api.js';

function PublicPlaceholder() {
  const [status, setStatus] = useState<FreelotteryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.status().then(setStatus).catch(e => setError(String(e)));
  }, []);

  return (
    <main>
      <h1>RPOW Free Lottery</h1>
      <p>100 days · 1,000 RPOW · daily draw at 19:00 UTC.</p>
      <p><a className="tweet-cta" href="/enter">Enter today's free lottery →</a></p>
      {error ? <pre className="error">{error}</pre> : null}
      {status ? <pre>{JSON.stringify(status, null, 2)}</pre> : null}
    </main>
  );
}

export function App() {
  // Tiny path-based router. The marketing public page is slice 4.
  const path = window.location.pathname;
  if (path === '/enter') return <Enter />;
  return <PublicPlaceholder />;
}
