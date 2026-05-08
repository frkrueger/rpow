import { useEffect, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import type { ActivityEntry } from '@rpow/shared';
import { formatRpow } from '../lib/format.js';

export function ActivityPage() {
  const [items, setItems] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.activity().then(setItems).catch(e => setError(e?.message ?? 'failed')); }, []);
  if (error) return <Panel title="ACTIVITY"><div className="error">{error}</div></Panel>;
  if (!items) return <Panel title="ACTIVITY"><div>loading...</div></Panel>;
  return (
    <Panel title="ACTIVITY">
      <pre style={{ margin: 0 }}>
{items.length === 0 ? '  (no activity yet)' : items.map(e => {
  const when = e.at.replace('T', ' ').slice(0, 19);
  const who = e.counterparty_email ?? '';
  const tag = e.type.toUpperCase().padEnd(8);
  const amt = `${e.type === 'send' ? '-' : '+'}${formatRpow(e.amount_base_units)}`;
  return `  ${when}  ${tag}  ${amt.padStart(12)}  ${who}`;
}).join('\n')}
      </pre>
    </Panel>
  );
}
