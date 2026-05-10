import { useEffect, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import type { LedgerResponse } from '@rpow/shared';
import { formatRpow } from '../lib/format.js';

export function LedgerPage() {
  const [d, setD] = useState<LedgerResponse | null>(null);
  useEffect(() => { api.ledger().then(setD); }, []);
  if (!d) return <Panel title="PUBLIC LEDGER"><div>loading...</div></Panel>;
  return (
    <>
      <Panel title="PUBLIC LEDGER">
        <div className="stat-grid">
          <div className="stat-cell">
            <div className="stat-label">MINTED</div>
            <div className="stat-value highlight">{formatRpow(d.minted_supply_counter_base_units)}</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">CIRCULATING</div>
            <div className="stat-value highlight">{formatRpow(d.circulating_supply_base_units)}</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">WRAPPED</div>
            <div className="stat-value">{formatRpow(d.wrapped_supply_base_units)}</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">TRANSFERRED</div>
            <div className="stat-value">{formatRpow(d.total_transferred_base_units)}</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">MINERS</div>
            <div className="stat-value">{d.user_count.toLocaleString()}</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">DIFFICULTY</div>
            <div className="stat-value">{d.current_difficulty_bits} bits</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">REWARD</div>
            <div className="stat-value">{formatRpow(d.current_reward_base_units)} RPOW</div>
          </div>
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--dim)' }}>
          a tribute to the original rpow by hal finney —
          {' '}<a href="https://nakamotoinstitute.org/finney/rpow/" target="_blank" rel="noreferrer">finney's announcement</a>
        </div>
      </Panel>

      <Panel title="ABOUT RPOW">
        <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--dim)' }}>
          <p style={{ margin: '0 0 12px' }}>Hal Finney published RPOW (Reusable Proofs of Work) in 2004 as the first cryptographic money based on proof-of-work. Bitcoin came four years later, in 2008/2009.</p>
          <p style={{ margin: '0 0 12px' }}>Finney was deeply involved in early Bitcoin: he received the first bitcoin transaction from Satoshi Nakamoto in January 2009. Many have speculated he was part of the team behind the Satoshi pseudonym — a claim he denied during his lifetime.</p>
          <p style={{ margin: '0 0 12px' }}>The original RPOW was centralized. A single trusted server, running on an IBM 4758 secure coprocessor, signed token transfers and prevented double-spends. There was no blockchain, no decentralized consensus, and no difficulty adjustment.</p>
          <p style={{ margin: '0 0 12px' }}>rpow2.com is a modern tribute to the spirit of Finney's original. No IBM 4758 — Ed25519 signatures, magic-link auth, Postgres ledger. Still centralized — but Bitcoin-flavored where it counts: a fixed 21,000,000 supply cap, and a halving schedule that reduces the reward as supply grows.</p>
          <p style={{ margin: '0 0 12px', color: 'var(--dimmer)' }}>Caveat: this IS a centralized system. The ledger lives in a Postgres database operated by one person on rented infrastructure. No warranty, no recovery guarantees. Treat it accordingly.</p>
        </div>
      </Panel>
    </>
  );
}
