import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * Invalidate VALID tokens owned by `email` summing to >= amount.
 * Mints a change token if the picked tokens overshoot.
 *
 * MUST be called inside a Postgres transaction (BEGIN already issued
 * on the passed PoolClient). Uses SELECT ... FOR UPDATE on tokens to
 * lock against concurrent /send.
 *
 * @param signFn called with the change-token's payload bytes; returns
 *               the signature bytes. The caller's real Ed25519 signer
 *               wraps signTokenPayload(privKey, payload).
 */
export async function burnFromUser(
  client: PoolClient,
  email: string,
  amount: bigint,
  signFn: (payload: Buffer) => Buffer,
): Promise<void> {
  if (amount <= 0n) throw new Error('amount must be positive');

  // Pick tokens largest-first to minimize the number of rows we invalidate.
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
    const changeId = randomUUID();
    const payload = Buffer.from(`${changeId}|${email}|${overage.toString()}|change`);
    const sig = signFn(payload);
    await client.query(
      `INSERT INTO tokens(id, owner_email, value, state, parent_token_id, server_sig)
       VALUES ($1, $2, $3::bigint, 'VALID', $4, $5)`,
      [changeId, email, overage.toString(), toInvalidate[0], sig],
    );
  }
}
