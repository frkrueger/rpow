import { useEffect, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import type { LedgerResponse } from '@rpow/shared';
import { formatRpow } from '../lib/format.js';

export function LedgerPage() {
  const [d, setD] = useState<LedgerResponse | null>(null);
  useEffect(() => { api.ledger().then(setD); }, []);
  if (!d) return <Panel title="PUBLIC LEDGER"><div>loading...</div></Panel>;
  const totalMinted = formatRpow(d.total_minted_base_units);
  const totalTransferred = formatRpow(d.total_transferred_base_units);
  const circulating = formatRpow(d.circulating_supply_base_units);
  return (
    <>
      <Panel title="PUBLIC LEDGER">
        <pre style={{ margin: 0 }}>
{`  TOTAL MINTED        : ${totalMinted} RPOW
  TOTAL TRANSFERRED   : ${totalTransferred} RPOW
  CIRCULATING SUPPLY  : ${circulating} RPOW
  CURRENT DIFFICULTY  : ${d.current_difficulty_bits} trailing zero bits
                        (constant; halving issuance, hard cap 21M)
  USER COUNT          : ${d.user_count}
`}
        </pre>
        <div style={{ marginTop: 12 }} className="tagline">
          a modern tribute to a tribute to the original rpow by hal finney —
          <a href="https://nakamotoinstitute.org/finney/rpow/" target="_blank" rel="noreferrer"> finney's announcement</a>
        </div>
      </Panel>

      <Panel title="ABOUT RPOW">
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
{`  Hal Finney published RPOW (Reusable Proofs of Work) in 2004 as the
  first cryptographic money based on proof-of-work. Bitcoin came four
  years later, in 2008/2009.

  Finney was deeply involved in early Bitcoin: he received the first
  bitcoin transaction from Satoshi Nakamoto in January 2009. Many have
  speculated he was part of the team behind the Satoshi pseudonym — a
  claim he denied during his lifetime.

  The original RPOW was centralized. A single trusted server, running
  on an IBM 4758 secure coprocessor, signed token transfers and
  prevented double-spends. There was no blockchain, no decentralized
  consensus, and no difficulty adjustment — meaning the supply was
  effectively unbounded as long as someone had compute. (A trusted
  server could enforce a cap; Finney just didn't.)

  Bitcoin solved all three: decentralized consensus via PoW mining tied
  to a chain, automatic difficulty adjustment, and a fixed 21M supply
  cap.

  rpow2.com is a modern tribute to the spirit of Finney's original.
  No IBM 4758 — Ed25519 signatures, magic-link auth, Postgres ledger.
  Still centralized — but Bitcoin-flavored where it counts: a fixed
  21,000,000 supply cap, and a stepped difficulty adjustment that
  adds one trailing-zero bit for every 1,000,000 coins minted.

  Founder allocation: 1,100,000 SRPOW (5.24% of the 21M cap) was
  allocated at launch as a "satoshi" tribute, vested linearly over
  one year via the Streamflow protocol on Solana. 19,900,000 of the
  21M cap remains mineable by users. No transfer fees on rpow.

  Caveat: this IS a centralized system. The ledger lives in a Postgres
  database operated by one person on rented infrastructure. If that
  server is breached, lost, or seized, your tokens may be lost with
  it. No warranty, no recovery guarantees, and no responsibility is
  taken for breaches, downtime, or data loss. Treat it accordingly.
`}
        </pre>
      </Panel>
    </>
  );
}
