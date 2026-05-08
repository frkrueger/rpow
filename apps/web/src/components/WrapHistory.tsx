import type { WrapEvent } from '@rpow/shared';
import { formatRpow } from '../lib/format.js';

interface Props { events: WrapEvent[] }

export function WrapHistory({ events }: Props) {
  if (!events.length) return <div style={{ color: '#888' }}>No wraps yet.</div>;
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {events.map(e => (
        <li
          key={e.event_id}
          style={{ borderTop: '1px solid #222', padding: '6px 0', fontFamily: 'monospace', fontSize: 12 }}
        >
          <span>{new Date(e.created_at).toISOString().slice(0, 16).replace('T', ' ')}</span>
          {' '}<span>{formatRpow(e.amount_base_units)} RPOW → SRPOW</span>
          {' '}<span style={{ color: statusColor(e.status) }}>{e.status}</span>
          {e.solana_signature && (
            <>
              {' '}
              <a
                href={`https://solscan.io/tx/${e.solana_signature}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: '#6ee7b7' }}
              >
                tx
              </a>
            </>
          )}
          {e.failure_reason && (
            <div style={{ color: '#f88', marginTop: 2 }}>{e.failure_reason}</div>
          )}
        </li>
      ))}
    </ul>
  );
}

function statusColor(s: WrapEvent['status']): string {
  if (s === 'CONFIRMED') return '#6ee7b7';
  if (s === 'PENDING') return '#fbbf24';
  return '#f88';
}
