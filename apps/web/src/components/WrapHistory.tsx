import type { WrapEvent } from '@rpow/shared';
import { formatRpow } from '../lib/format.js';

interface Props { events: WrapEvent[] }

export function WrapHistory({ events }: Props) {
  if (!events.length) return <div style={{ color: '#888' }}>No activity yet.</div>;
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {events.map(e => {
        const isUnwrap = e.direction === 'UNWRAP';
        return (
          <li
            key={e.event_id}
            style={{ borderTop: '1px solid #222', padding: '6px 0', fontFamily: 'monospace', fontSize: 12 }}
          >
            <span>{new Date(e.created_at).toISOString().slice(0, 16).replace('T', ' ')}</span>
            {' '}
            <span style={{ color: isUnwrap ? '#ffc857' : '#7ec8e3' }}>
              {isUnwrap ? '↩ UNWRAP' : '↪ WRAP'}
            </span>
            {' '}
            <span>
              {isUnwrap
                ? `${formatRpow(e.amount_base_units)} SRPOW → RPOW`
                : `${formatRpow(e.amount_base_units)} RPOW → SRPOW`}
            </span>
            {' '}<span style={{ color: statusColor(e.status) }}>{e.status}</span>
            {e.solana_signature && (
              <>
                {' '}
                <TxLink sig={e.solana_signature} label={isUnwrap ? 'inbound' : 'tx'} />
              </>
            )}
            {e.swap_signature && (
              <>
                {' '}
                <TxLink sig={e.swap_signature} label="swap" />
              </>
            )}
            {e.burn_signature && (
              <>
                {' '}
                <TxLink sig={e.burn_signature} label="burn" />
              </>
            )}
            {e.failure_reason && (
              <div style={{ color: '#f88', marginTop: 2 }}>{e.failure_reason}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function TxLink({ sig, label }: { sig: string; label: string }) {
  return (
    <a
      href={`https://solscan.io/tx/${sig}`}
      target="_blank"
      rel="noreferrer"
      style={{ color: '#6ee7b7' }}
    >
      {label}
    </a>
  );
}

function statusColor(s: WrapEvent['status']): string {
  if (s === 'CONFIRMED') return '#6ee7b7';
  if (s === 'PENDING') return '#fbbf24';
  return '#f88';
}
