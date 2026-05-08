import { useEffect, useState } from 'react';
import { Panel } from '../components/Panel.js';
import { api } from '../api.js';
import type { LedgerResponse } from '@rpow/shared';

type LedgerDetails = LedgerResponse & {
};

function n(v: number | undefined) {
  return typeof v === 'number' ? v.toLocaleString() : '--';
}

export function LedgerPage() {
  const [d, setD] = useState<LedgerDetails | null>(null);
  useEffect(() => { api.ledger().then(setD); }, []);
  if (!d) return <Panel title="PUBLIC LEDGER"><div>loading...</div></Panel>;
  const latest = d.latest_token;
  const pubkey = d.signing_public_key ?? d.public_key_pem_url ?? '/.well-known/rpow-pubkey.pem';
  return (
    <>
      <Panel title="PUBLIC LEDGER">
        <pre style={{ margin: 0 }}>
{`  TOTAL MINTED        : ${n(d.total_minted)}
  TOTAL TRANSFERRED   : ${n(d.total_transferred)}
  CIRCULATING SUPPLY  : ${n(d.circulating_supply)}
  MAX SUPPLY          : ${n(d.max_supply)}
  EPOCH               : ${d.epoch ?? '--'}${d.epoch_size ? ` (${n(d.epoch_size)} coins/epoch)` : ''}
  CURRENT DIFFICULTY  : ${d.current_difficulty_bits} trailing zero bits
  NEXT DIFFICULTY     : ${d.next_difficulty_bits ?? '--'} trailing zero bits
  NEXT MILESTONE      : ${n(d.next_milestone_at)} minted
  COINS UNTIL NEXT    : ${n(d.coins_until_next_milestone)}
  USER COUNT          : ${n(d.user_count)}
  CAP STATUS          : ${d.is_capped ? 'MAX SUPPLY REACHED' : 'open'}
`}
        </pre>
        <div style={{ marginTop: 12 }} className="tagline">
          a modern tribute to a tribute to the original rpow by hal finney —
          <a href="https://nakamotoinstitute.org/finney/rpow/" target="_blank" rel="noreferrer"> finney's announcement</a>
        </div>
      </Panel>

      <Panel title="TOKEN PROVENANCE">
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
{`  MODEL        : each RPOW is a server-signed token. On transfer, sender
                 tokens are invalidated and fresh recipient tokens are issued.
  SIGNATURE    : Ed25519 over canonical token payload
  PUBLIC KEY   : ${pubkey}
  VERIFY PEM   : /.well-known/rpow-pubkey.pem

  LATEST TOKEN : ${latest?.id ?? 'not returned by /ledger yet'}
  PARENT TOKEN : ${latest?.parent_token_id ?? 'root mint or not returned'}
  OWNER HASH   : ${latest?.owner_email_hash ?? 'not returned'}
  VALUE        : ${latest?.value ?? 1} RPOW
  ISSUED AT    : ${latest?.issued_at ?? 'not returned'}
  SERVER SIG   : ${latest?.server_sig ?? 'not returned'}
`}
        </pre>
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
`}
        </pre>
      </Panel>
    </>
  );
}
