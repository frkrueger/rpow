import type { Pool } from 'pg';
import type { BridgeClient } from '@rpow/solana-bridge';
import { withTx } from './db.js';

export async function reconcilePendingWraps(pool: Pool, bridge: BridgeClient): Promise<void> {
  const { rows } = await pool.query<{ id: string; solana_signature: string | null }>(
    `SELECT id, solana_signature FROM srpow_wrap_events WHERE status='PENDING' AND direction='WRAP'`,
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
    // Source tokens (is_change=false) -> WRAPPED.
    await c.query(
      `UPDATE tokens SET state='WRAPPED' WHERE wrap_event_id=$1 AND is_change=FALSE`,
      [eventId],
    );
    // Change token (is_change=true), if any, becomes spendable.
    await c.query(
      `UPDATE tokens SET state='VALID' WHERE wrap_event_id=$1 AND is_change=TRUE`,
      [eventId],
    );
  });
}

async function refund(pool: Pool, eventId: string, reason: string): Promise<void> {
  await withTx(pool, async (c) => {
    await c.query(
      `UPDATE srpow_wrap_events SET status='REFUNDED', failure_reason=$1, updated_at=now() WHERE id=$2`,
      [reason, eventId],
    );
    // Restore source tokens to VALID; clear the wrap_event_id link.
    await c.query(
      `UPDATE tokens SET state='VALID', wrap_event_id=NULL
       WHERE wrap_event_id=$1 AND is_change=FALSE`,
      [eventId],
    );
    // Discard any change token that was provisionally issued — it was never
    // user-visible (state was LOCKED_FOR_BRIDGE) so deleting it is safe.
    await c.query(
      `DELETE FROM tokens WHERE wrap_event_id=$1 AND is_change=TRUE`,
      [eventId],
    );
  });
}
