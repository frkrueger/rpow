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
  if (items.length === 0) return <Panel title="ACTIVITY"><div style={{ color: 'var(--dim)' }}>no activity yet</div></Panel>;
  return (
    <Panel title="ACTIVITY">
      {items.map((e, i) => {
        const time = e.at.replace('T', ' ').slice(11, 16);
        const date = e.at.slice(0, 10);
        const sign = e.type === 'send' ? '-' : '+';
        const badgeClass = `activity-badge ${e.type}`;
        const amountColor = e.type === 'send' ? 'var(--amber)' : e.type === 'receive' ? '#60a5fa' : 'var(--accent)';
        return (
          <div key={i} className="activity-item">
            <span className="activity-time" title={date}>{time}</span>
            <span className={badgeClass}>{e.type.toUpperCase()}</span>
            <span style={{ color: 'var(--dim)', fontSize: 11 }}>
              {e.counterparty_email ? `${e.type === 'send' ? '→' : '←'} ${e.counterparty_email}` : ''}
              {e.memo ? <> · memo: <code style={{ background: 'rgba(110,231,183,0.06)', padding: '0 4px' }}>{e.memo}</code></> : null}
            </span>
            <span className="activity-amount" style={{ color: amountColor }}>
              {sign}{formatRpow(e.amount_base_units)}
            </span>
          </div>
        );
      })}
    </Panel>
  );
}
