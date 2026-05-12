import type { Pool } from 'pg';
import { withTx } from '../db.js';
import { extractUsdcTransfersTo } from './usdc-indexer-classifier.js';

export interface TransferRecord {
  sig: string;
  amount: bigint;
  authority: string;
  blockTime: Date | null;
}

export async function loadCursor(pool: Pool): Promise<string | null> {
  const r = await pool.query<{ last_signature: string | null }>(
    `SELECT last_signature FROM amm_indexer_state WHERE key='usdc_deposits'`,
  );
  return r.rows[0]?.last_signature ?? null;
}

export async function advanceCursor(pool: Pool, sig: string): Promise<void> {
  await pool.query(
    `UPDATE amm_indexer_state SET last_signature=$1, last_run_at=now() WHERE key='usdc_deposits'`,
    [sig],
  );
}

export async function touchCursorTimestamp(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE amm_indexer_state SET last_run_at=now() WHERE key='usdc_deposits'`,
  );
}

export async function persistTransfer(pool: Pool, r: TransferRecord): Promise<void> {
  await withTx(pool, async (c) => {
    const user = await c.query<{ email: string }>(
      `SELECT email FROM users WHERE solana_pubkey = $1 FOR UPDATE`,
      [r.authority],
    );
    if (user.rows[0]) {
      const ins = await c.query(`
        INSERT INTO usdc_deposits(account_email, amount_base_units, solana_signature, sender_pubkey, block_time)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (solana_signature) DO NOTHING
        RETURNING id
      `, [user.rows[0].email, r.amount.toString(), r.sig, r.authority, r.blockTime]);
      if ((ins.rowCount ?? 0) > 0) {
        await c.query(
          `UPDATE users SET usdc_base_units = usdc_base_units + $1 WHERE email = $2`,
          [r.amount.toString(), user.rows[0].email],
        );
      }
      return;
    }
    await c.query(`
      INSERT INTO usdc_unattributed_deposits(amount_base_units, solana_signature, sender_pubkey, block_time)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (solana_signature) DO NOTHING
    `, [r.amount.toString(), r.sig, r.authority, r.blockTime]);
  });
}

export interface IndexerDeps {
  pool: Pool;
  rpc: {
    getSignaturesForAddress: (
      address: string,
      opts?: { until?: string; before?: string; limit?: number; commitment?: string }
    ) => Promise<Array<{ signature: string; err: any; blockTime: number | null }>>;
    getParsedTransaction: (sig: string, opts?: any) => Promise<any | null>;
  };
  ammAta: string;
  usdcMint: string;
  log: { debug: (...a: any[]) => void; info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
  bootstrapLimit: number;
}

async function fetchNewSignatures(
  rpc: IndexerDeps['rpc'],
  ata: string,
  cursor: string | null,
  bootstrapLimit: number,
): Promise<Array<{ signature: string; err: any; blockTime: number | null }>> {
  const out: Array<{ signature: string; err: any; blockTime: number | null }> = [];
  let before: string | undefined = undefined;
  while (true) {
    const opts: any = { commitment: 'finalized', limit: 1000 };
    if (cursor) opts.until = cursor;
    if (before) opts.before = before;
    const page = await rpc.getSignaturesForAddress(ata, opts);
    if (!page || page.length === 0) break;
    out.push(...page);
    if (page.length < 1000) break;
    if (!cursor && out.length >= bootstrapLimit) {
      // bootstrap cap
      return out.slice(0, bootstrapLimit);
    }
    before = page[page.length - 1].signature;
  }
  return out;
}

export async function tick(deps: IndexerDeps): Promise<void> {
  const { pool, rpc, log, ammAta, usdcMint, bootstrapLimit } = deps;
  const cursor = await loadCursor(pool);
  let sigs: Array<{ signature: string; err: any; blockTime: number | null }>;
  try {
    sigs = await fetchNewSignatures(rpc, ammAta, cursor, bootstrapLimit);
  } catch (e) {
    log.warn({ err: String(e) }, 'indexer: getSignaturesForAddress failed; retry next tick');
    return;
  }
  if (sigs.length === 0) {
    await touchCursorTimestamp(pool);
    return;
  }

  // RPC returns newest-first; process oldest-first so the cursor advances monotonically.
  sigs.reverse();
  for (const si of sigs) {
    if (si.err) {
      log.debug({ sig: si.signature }, 'indexer: skip failed tx');
      await advanceCursor(pool, si.signature);
      continue;
    }
    let tx: any;
    try {
      tx = await rpc.getParsedTransaction(si.signature, { maxSupportedTransactionVersion: 0, commitment: 'finalized' });
    } catch (e) {
      log.warn({ sig: si.signature, err: String(e) }, 'indexer: getParsedTransaction threw; will retry');
      break;
    }
    if (!tx) {
      log.warn({ sig: si.signature }, 'indexer: parsed tx null; will retry next tick');
      break;
    }
    const transfers = extractUsdcTransfersTo(tx, ammAta, usdcMint);
    const blockTime = si.blockTime ? new Date(si.blockTime * 1000) : null;
    for (const t of transfers) {
      await persistTransfer(pool, { sig: si.signature, amount: t.amount, authority: t.authority, blockTime });
    }
    await advanceCursor(pool, si.signature);
  }
}
