import type { Pool } from 'pg';
import type { BridgeClient } from '@rpow/solana-bridge';
import { withTx } from './db.js';

export async function reconcilePendingWraps(pool: Pool, bridge: BridgeClient): Promise<void> {
  const { rows } = await pool.query<{ id: string; solana_signature: string | null }>(
    `SELECT id, solana_signature FROM srpow_wrap_events WHERE status='PENDING'`,
  );
  for (const ev of rows) {
    if (!ev.solana_signature) {
      await refund(pool, ev.id, 'reconcile: no signature recorded');
      continue;
    }
    let resolved: 'confirmed' | 'failed' | 'not_found' | 'pending';
    try {
      resolved = await bridge.getSignatureStatus(ev.solana_signature);
    } catch (e: any) {
      console.error(`reconcile getSignatureStatus failed for ${ev.id}:`, e?.message ?? e);
      continue;            // leave PENDING; next boot will retry
    }
    if (resolved === 'confirmed') {
      await confirm(pool, ev.id);
    } else if (resolved === 'pending') {
      // Tx submitted but below commitment threshold. Do not refund — it may
      // still confirm. Leave PENDING for the next reboot's reconcile pass.
      continue;
    } else {
      // 'failed' or 'not_found' — safe to refund.
      await refund(pool, ev.id, `reconcile: signature ${resolved}`);
    }
  }
}

async function confirm(pool: Pool, eventId: string): Promise<void> {
  await withTx(pool, async (c) => {
    await c.query(`UPDATE srpow_wrap_events SET status='CONFIRMED', updated_at=now() WHERE id=$1`, [eventId]);
    await c.query(`UPDATE tokens SET state='WRAPPED' WHERE wrap_event_id=$1`, [eventId]);
  });
}

async function refund(pool: Pool, eventId: string, reason: string): Promise<void> {
  await withTx(pool, async (c) => {
    await c.query(
      `UPDATE srpow_wrap_events SET status='REFUNDED', failure_reason=$1, updated_at=now() WHERE id=$2`,
      [reason, eventId],
    );
    await c.query(
      `UPDATE tokens SET state='VALID', wrap_event_id=NULL WHERE wrap_event_id=$1`,
      [eventId],
    );
  });
}
