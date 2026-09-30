import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { signTokenPayload } from '../signing.js';

/**
 * Invalidate VALID tokens owned by `email` summing to >= amount.
 * Mints a change token if the picked tokens overshoot.
 *
 * MUST be called inside a Postgres transaction (BEGIN already issued
 * on the passed PoolClient). Uses SELECT ... FOR UPDATE on tokens to
 * lock against concurrent /send.
 *
 * @param privateKeyHex  Ed25519 private key (hex) used to sign the
 *                       change token via signTokenPayload — same key
 *                       that signs all other RPOW tokens.
 */
export async function burnFromUser(
  client: PoolClient,
  email: string,
  amount: bigint,
  privateKeyHex: string,
): Promise<void> {
  if (amount <= 0n) throw new Error('amount must be positive');

  // Plain FOR UPDATE (not SKIP LOCKED): if a concurrent /send is mid-flight,
  // wait for it rather than seeing a partial balance and falsely throwing
  // INSUFFICIENT_BALANCE. Brief lock contention is acceptable on a lose-spin.
  const { rows } = await client.query<{ id: string; value: string }>(
    `SELECT id, value::text FROM tokens
     WHERE owner_email = $1 AND state = 'VALID'
     ORDER BY value DESC
     FOR UPDATE`,
    [email],
  );
  let collected = 0n;
  const toInvalidate: string[] = [];
  for (const r of rows) {
    if (collected >= amount) break;
    toInvalidate.push(r.id);
    collected += BigInt(r.value);
  }
  if (collected < amount) {
    throw new Error('INSUFFICIENT_BALANCE');
  }

  // Invalidate the picked tokens.
  await client.query(
    `UPDATE tokens SET state = 'INVALIDATED', invalidated_at = now()
     WHERE id = ANY($1::uuid[])`,
    [toInvalidate],
  );

  // Mint change for any overage. Parent links to the first invalidated token
  // so the change is auditable as derived from a real burn (consistent with
  // how /send change tokens are linked to their parents).
  const overage = collected - amount;
  if (overage > 0n) {
    const issuedAt = new Date();
    const changeId = randomUUID();
    const ownerEmailHash = createHash('sha256').update(email).digest('hex');
    const sig = signTokenPayload(
      { id: changeId, owner_email_hash: ownerEmailHash, value: overage, issued_at: issuedAt.toISOString() },
      privateKeyHex,
    );
    await client.query(
      `INSERT INTO tokens(id, owner_email, value, state, issued_at, parent_token_id, server_sig)
       VALUES ($1, $2, $3::bigint, 'VALID', $4, $5, $6)`,
      [changeId, email, overage.toString(), issuedAt, toInvalidate[0], sig],
    );
  }
}
