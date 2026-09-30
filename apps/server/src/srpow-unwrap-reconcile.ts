import type { Pool } from 'pg';
import type { BridgeClient } from '@rpow/solana-bridge';
import { withTx } from './db.js';
import { createHash, randomUUID } from 'node:crypto';
import { signTokenPayload } from './signing.js';

export interface ReconcileConfig {
  signingPrivateKeyHex: string;
  srpowUnwrapFeeBps: number;
}

export async function reconcilePendingUnwraps(
  pool: Pool, bridge: BridgeClient, cfg: ReconcileConfig,
): Promise<void> {
  const { rows } = await pool.query<{
    id: string; user_email: string; amount: string; solana_wallet: string;
    solana_signature: string | null; swap_signature: string | null; burn_signature: string | null;
  }>(
    `SELECT id, user_email, amount::text AS amount, solana_wallet,
            solana_signature, swap_signature, burn_signature
     FROM srpow_wrap_events
     WHERE status='PENDING' AND direction='UNWRAP'`,
  );

  for (const ev of rows) {
    if (!ev.solana_signature) {
      await markFailed(pool, ev.id, 'reconcile: no inbound signature');
      continue;
    }

    let inboundStatus: string;
    try {
      inboundStatus = await bridge.getSignatureStatus(ev.solana_signature);
    } catch (e: any) {
      console.error(`reconcile inbound status failed ${ev.id}: ${e?.message ?? e}`);
      continue;
    }
    if (inboundStatus === 'pending') continue;
    if (inboundStatus === 'not_found' || inboundStatus === 'failed') {
      await markFailed(pool, ev.id, `reconcile: inbound ${inboundStatus}`);
      continue;
    }

    // From here, inbound is confirmed.
    if (!ev.swap_signature) {
      // Never executed swap; safest action is to mark FAILED for manual review.
      await markFailed(pool, ev.id, 'reconcile: inbound confirmed but no swap_signature — manual review');
      continue;
    }

    let swapStatus: string;
    try {
      swapStatus = await bridge.getSignatureStatus(ev.swap_signature);
    } catch (e: any) {
      console.error(`reconcile swap status failed ${ev.id}: ${e?.message ?? e}`);
      continue;
    }
    if (swapStatus === 'pending') continue;
    if (swapStatus === 'not_found' || swapStatus === 'failed') {
      // Check if a prior refund attempt already landed (route-time timeout case).
      // The route stores refund sigs in burn_signature (operational compromise).
      if (ev.burn_signature) {
        try {
          const priorStatus = await bridge.getSignatureStatus(ev.burn_signature);
          if (priorStatus === 'confirmed') {
            await pool.query(
              `UPDATE srpow_wrap_events SET status='REFUNDED', failure_reason=$1, updated_at=now() WHERE id=$2`,
              [`reconcile: swap ${swapStatus}; refund already confirmed`, ev.id],
            );
            continue;
          }
          if (priorStatus === 'pending') {
            // Prior refund still in flight — leave row PENDING; next pass will retry.
            continue;
          }
          // 'failed' / 'not_found' — fall through to issue a fresh refund.
        } catch (e: any) {
          console.error(`reconcile prior-refund status check failed ${ev.id}: ${e?.message ?? e}`);
          continue;
        }
      }
      // Issue a fresh refund.
      const refund = await bridge.transferSrpowFromBridge(
        ev.solana_wallet, BigInt(ev.amount),
        async (_sig) => {},
      );
      if (refund.status !== 'confirmed') {
        console.error(`reconcile refund failed ${ev.id}`);
        continue;
      }
      await pool.query(
        `UPDATE srpow_wrap_events SET status='REFUNDED', failure_reason=$1, updated_at=now() WHERE id=$2`,
        [`reconcile: swap ${swapStatus}`, ev.id],
      );
      continue;
    }

    // Swap confirmed. Check burn.
    const amount = BigInt(ev.amount);
    const feeAmount = (amount * BigInt(cfg.srpowUnwrapFeeBps)) / 10000n;
    const burnAmount = amount - feeAmount;

    if (!ev.burn_signature) {
      // Resume burn step.
      const burn = await bridge.burnSrpow(
        burnAmount,
        async (sig) => {
          await pool.query(
            `UPDATE srpow_wrap_events SET burn_signature=$1, updated_at=now() WHERE id=$2`,
            [sig, ev.id],
          );
        },
      );
      if (burn.status !== 'confirmed') {
        console.error(`reconcile burn failed ${ev.id}`);
        continue;
      }
      await creditAndFinalize(pool, cfg.signingPrivateKeyHex, ev.id, ev.user_email, burnAmount, feeAmount);
      continue;
    }

    let burnStatus: string;
    try {
      burnStatus = await bridge.getSignatureStatus(ev.burn_signature);
    } catch (e: any) {
      console.error(`reconcile burn status failed ${ev.id}: ${e?.message ?? e}`);
      continue;
    }
    if (burnStatus === 'pending') continue;
    if (burnStatus === 'not_found' || burnStatus === 'failed') {
      // Retry burn.
      const burn = await bridge.burnSrpow(
        burnAmount,
        async (sig) => {
          await pool.query(
            `UPDATE srpow_wrap_events SET burn_signature=$1, updated_at=now() WHERE id=$2`,
            [sig, ev.id],
          );
        },
      );
      if (burn.status !== 'confirmed') continue;
      await creditAndFinalize(pool, cfg.signingPrivateKeyHex, ev.id, ev.user_email, burnAmount, feeAmount);
      continue;
    }

    // All three confirmed. Credit if not already done.
    const { rows: existing } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tokens WHERE wrap_event_id=$1`,
      [ev.id],
    );
    if (existing[0].n === 0) {
      await creditAndFinalize(pool, cfg.signingPrivateKeyHex, ev.id, ev.user_email, burnAmount, feeAmount);
    } else {
      await pool.query(`UPDATE srpow_wrap_events SET status='CONFIRMED', updated_at=now() WHERE id=$1`, [ev.id]);
    }
  }
}

async function markFailed(pool: Pool, id: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE srpow_wrap_events SET status='FAILED', failure_reason=$1, updated_at=now() WHERE id=$2`,
    [reason, id],
  );
}

async function creditAndFinalize(
  pool: Pool, signingPrivateKeyHex: string, eventId: string, userEmail: string,
  creditAmount: bigint, feeBurnedAmount: bigint,
): Promise<void> {
  await withTx(pool, async (c) => {
    const tokenId = randomUUID();
    const issuedAt = new Date();
    const ownerHash = createHash('sha256').update(userEmail).digest('hex');
    const sig = signTokenPayload(
      { id: tokenId, owner_email_hash: ownerHash, value: creditAmount, issued_at: issuedAt.toISOString() },
      signingPrivateKeyHex,
    );
    await c.query(
      `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig, wrap_event_id, is_change)
       VALUES($1, $2, $3, 'VALID', $4, $5, $6, FALSE)`,
      [tokenId, userEmail, creditAmount.toString(), issuedAt, sig, eventId],
    );
    const wrappedShard = Math.floor(Math.random() * 128);
    await c.query(
      `UPDATE app_counters SET value = value - $1
       WHERE name='wrapped_supply_base_units' AND shard=$2`,
      [creditAmount.toString(), wrappedShard],
    );
    const feeShard = Math.floor(Math.random() * 128);
    await c.query(
      `UPDATE app_counters SET value = value + $1
       WHERE name='unwrap_fee_burned_srpow_base_units' AND shard=$2`,
      [feeBurnedAmount.toString(), feeShard],
    );
    await c.query(
      `UPDATE srpow_wrap_events SET status='CONFIRMED', updated_at=now() WHERE id=$1`,
      [eventId],
    );
  });
}
