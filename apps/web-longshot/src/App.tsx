import { useEffect, useState } from 'react';
import { fetchMe, fetchAccess, formatRpow, type Me } from './api.js';

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [access, setAccess] = useState<'allowed' | 'denied' | 'unauthenticated' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMe().then(setMe).catch(e => setError(String(e)));
    fetchAccess().then(setAccess).catch(() => setAccess('denied'));
  }, []);

  if (error) return <main><p style={{ color: 'var(--warn)' }}>error: {error}</p></main>;
  if (!me) return <main><p>not signed in. <a href="https://rpow2.com" style={{ color: 'var(--accent)' }}>sign in at rpow2.com</a> and return.</p></main>;

  if (access === 'denied') return (
    <main>
      <h1>RPOW Long Shot</h1>
      <p>Early access — RPOW Long Shot is currently limited to a small allowlist while we validate behavior. Coming soon to all rpow accounts.</p>
      <p style={{ color: 'var(--dim)', fontSize: '.86rem' }}>signed in as {me.email}</p>
    </main>
  );

  return (
    <main>
      <h1>RPOW Long Shot</h1>
      <p>balance: <strong>{formatRpow(me.balance_base_units)} RPOW</strong></p>
      <p style={{ color: 'var(--dim)', fontSize: '.86rem' }}>signed in as {me.email}</p>
    </main>
  );
}
