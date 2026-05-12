import type { Pool } from 'pg';
import { withTx } from '../db.js';

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
