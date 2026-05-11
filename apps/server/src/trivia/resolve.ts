import type { PoolClient } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { signMatchPayload, signTokenPayload, type MatchPayload } from '../signing.js';

const BASE_UNITS_PER_RPOW = 1_000_000_000n;

export interface ResolveCtx {
  signingPrivateKeyHex: string;
  mintMaxSupply: string | number;
}

export interface ResolveResult {
  winner_email: string;
  signature: Buffer;
  resolved_at: Date;
  session_status: 'OPEN' | 'CLOSED';
  bankroll_remaining: bigint;
  closed_at: Date | null;
}

/**
 * Apply the §4 resolution rules to one ACTIVE match and atomically:
 *   - update bankroll + W/L counters on the offerer's session
 *   - mint payout to challenger if challenger wins
 *   - auto-close the session if bankroll drops below bet (minting remainder back)
 *   - sign the canonical MatchPayload and write state='RESOLVED'
 *
 * Caller is responsible for opening the surrounding `withTx`. This function
 * always acquires `FOR UPDATE` locks on the match and session rows, so the
 * caller does not need to pre-lock — but a pre-existing lock is harmless.
 *
 * Idempotent: if the match is already RESOLVED, returns the persisted state
 * without mutating anything.
 */
export async function resolveMatchTx(
  c: PoolClient,
  matchId: string,
  ctx: ResolveCtx,
): Promise<ResolveResult> {
  // Step 1: Lock the match row and fetch it with the correct answer
  const matchRes = await c.query<{
    id: string;
    offerer_session_id: string;
    offerer_email: string;
    challenger_email: string;
    bet_base_units: string;
    question_id: string;
    state: string;
    offerer_choice_idx: number | null;
    offerer_answered_at: Date | null;
    challenger_choice_idx: number | null;
    challenger_answered_at: Date | null;
    winner_email: string | null;
    signature: Buffer | null;
    created_at: Date;
    resolved_at: Date | null;
    correct_idx: number;
  }>(
    `SELECT m.id, m.offerer_session_id, m.offerer_email, m.challenger_email,
            m.bet_base_units::text, m.question_id, m.state,
            m.offerer_choice_idx, m.offerer_answered_at,
            m.challenger_choice_idx, m.challenger_answered_at,
            m.winner_email, m.signature, m.created_at, m.resolved_at,
            q.correct_idx
     FROM trivia_matches m
     JOIN trivia_questions q ON q.id = m.question_id
     WHERE m.id = $1
     FOR UPDATE OF m`,
    [matchId],
  );
  if (matchRes.rows.length === 0) {
    throw new Error('MATCH_NOT_FOUND');
  }
  const m = matchRes.rows[0];

  // Step 2: Idempotency — if already resolved, return persisted state
  if (m.state === 'RESOLVED') {
    const sess = await c.query<{
      status: 'OPEN' | 'CLOSED';
      bankroll_remaining_base_units: string;
      closed_at: Date | null;
    }>(
      `SELECT status, bankroll_remaining_base_units::text, closed_at
       FROM trivia_sessions WHERE id = $1`,
      [m.offerer_session_id],
    );
    return {
      winner_email: m.winner_email!,
      signature: m.signature!,
      resolved_at: m.resolved_at!,
      session_status: sess.rows[0].status,
      bankroll_remaining: BigInt(sess.rows[0].bankroll_remaining_base_units),
      closed_at: sess.rows[0].closed_at,
    };
  }

  // Step 3: Lock the offerer session row
  const sessRes = await c.query<{
    bankroll_remaining_base_units: string;
    status: string;
  }>(
    `SELECT bankroll_remaining_base_units::text, status
     FROM trivia_sessions WHERE id = $1 FOR UPDATE`,
    [m.offerer_session_id],
  );
  if (sessRes.rows.length === 0) {
    throw new Error('SESSION_NOT_FOUND');
  }
  const bet = BigInt(m.bet_base_units);
  const bankroll = BigInt(sessRes.rows[0].bankroll_remaining_base_units);

  // Step 4: Compute winner per §4 rules
  const offererCorrect = m.offerer_choice_idx === m.correct_idx;
  const challengerCorrect = m.challenger_choice_idx === m.correct_idx;
  let winnerEmail: string;
  if (offererCorrect && challengerCorrect) {
    // Both correct: faster wins, tie or null timestamps → offerer
    if (
      m.challenger_answered_at !== null &&
      m.offerer_answered_at !== null &&
      m.challenger_answered_at.getTime() < m.offerer_answered_at.getTime()
    ) {
      winnerEmail = m.challenger_email;
    } else {
      winnerEmail = m.offerer_email; // includes the tie case
    }
  } else if (offererCorrect) {
    winnerEmail = m.offerer_email;
  } else if (challengerCorrect) {
    winnerEmail = m.challenger_email;
  } else {
    // Both wrong / timeout / both null → offerer wins
    winnerEmail = m.offerer_email;
  }

  // Steps 5 & 6: Update bankroll and W/L counters; mint payout if challenger won
  const capBaseUnits = BigInt(ctx.mintMaxSupply) * BASE_UNITS_PER_RPOW;
  let newBankroll: bigint;

  if (winnerEmail === m.challenger_email) {
    // Step 5: Challenger wins — bankroll -= bet, matches_lost += 1, mint 2*bet to challenger
    newBankroll = bankroll - bet;
    await c.query(
      `UPDATE trivia_sessions
       SET bankroll_remaining_base_units = $1::bigint,
           matches_lost = matches_lost + 1,
           last_match_at = now()
       WHERE id = $2`,
      [newBankroll.toString(), m.offerer_session_id],
    );

    const payout = bet * 2n;
    const supplyResult = await c.query(
      `UPDATE app_counters SET value = value + $1::bigint
       WHERE name = 'minted_supply' AND value + $1::bigint <= $2::bigint`,
      [payout.toString(), capBaseUnits.toString()],
    );
    if ((supplyResult.rowCount ?? 0) === 0) {
      throw new Error('SUPPLY_CAP_REACHED');
    }

    const tokenId = randomUUID();
    const issuedAt = new Date();
    const ownerEmailHash = createHash('sha256').update(m.challenger_email).digest('hex');
    const sig = signTokenPayload(
      { id: tokenId, owner_email_hash: ownerEmailHash, value: payout, issued_at: issuedAt.toISOString() },
      ctx.signingPrivateKeyHex,
    );
    await c.query(
      `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
       VALUES($1, $2, $3, 'VALID', $4, $5)`,
      [tokenId, m.challenger_email, payout.toString(), issuedAt, sig],
    );
  } else {
    // Step 6: Offerer wins — bankroll += bet, matches_won += 1, no mint
    newBankroll = bankroll + bet;
    await c.query(
      `UPDATE trivia_sessions
       SET bankroll_remaining_base_units = $1::bigint,
           matches_won = matches_won + 1,
           last_match_at = now()
       WHERE id = $2`,
      [newBankroll.toString(), m.offerer_session_id],
    );
  }

  // Step 7: last_match_at is already set above in both branches

  // Step 8: Auto-close if bankroll dropped below bet
  let sessionStatus: 'OPEN' | 'CLOSED' = 'OPEN';
  let closedAt: Date | null = null;
  if (newBankroll < bet) {
    // Mint remainder back to offerer (if any remainder)
    if (newBankroll > 0n) {
      const supplyResult = await c.query(
        `UPDATE app_counters SET value = value + $1::bigint
         WHERE name = 'minted_supply' AND value + $1::bigint <= $2::bigint`,
        [newBankroll.toString(), capBaseUnits.toString()],
      );
      if ((supplyResult.rowCount ?? 0) === 0) {
        throw new Error('SUPPLY_CAP_REACHED');
      }
      const tokenId = randomUUID();
      const issuedAt = new Date();
      const ownerEmailHash = createHash('sha256').update(m.offerer_email).digest('hex');
      const sig = signTokenPayload(
        { id: tokenId, owner_email_hash: ownerEmailHash, value: newBankroll, issued_at: issuedAt.toISOString() },
        ctx.signingPrivateKeyHex,
      );
      await c.query(
        `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
         VALUES($1, $2, $3, 'VALID', $4, $5)`,
        [tokenId, m.offerer_email, newBankroll.toString(), issuedAt, sig],
      );
    }

    const closeRes = await c.query<{ closed_at: Date }>(
      `UPDATE trivia_sessions
       SET status = 'CLOSED', closed_at = now()
       WHERE id = $1
       RETURNING closed_at`,
      [m.offerer_session_id],
    );
    sessionStatus = 'CLOSED';
    closedAt = closeRes.rows[0].closed_at;

    // Insert SYSTEM chat message
    const handleRes = await c.query<{ x_handle: string | null }>(
      `SELECT x_handle FROM users WHERE email = $1`,
      [m.offerer_email],
    );
    const handle = handleRes.rows[0]?.x_handle ?? m.offerer_email;
    await c.query(
      `INSERT INTO trivia_chat_messages(id, account_email, x_handle, kind, body)
       VALUES($1, NULL, NULL, 'SYSTEM', $2)`,
      [randomUUID(), `@${handle} drained out of the arena`],
    );
  }

  // Step 9: Build canonical MatchPayload, sign it, then write state='RESOLVED',
  // winner_email, signature, and resolved_at all in one UPDATE (the check
  // constraint requires all four to be set atomically).
  //
  // We sign with the timestamps already stored on the row (offerer_answered_at,
  // challenger_answered_at, created_at). resolved_at comes from the DB via
  // RETURNING so we can return it to callers.
  const payload: MatchPayload = {
    id: matchId,
    offerer_email_hash: createHash('sha256').update(m.offerer_email).digest('hex'),
    challenger_email_hash: createHash('sha256').update(m.challenger_email).digest('hex'),
    bet_base_units: bet,
    question_id: m.question_id,
    offerer_choice_idx: m.offerer_choice_idx,
    offerer_answered_at: m.offerer_answered_at?.toISOString() ?? null,
    challenger_choice_idx: m.challenger_choice_idx,
    challenger_answered_at: m.challenger_answered_at?.toISOString() ?? null,
    winner_email_hash: createHash('sha256').update(winnerEmail).digest('hex'),
    created_at: m.created_at.toISOString(),
  };
  const signature = signMatchPayload(payload, ctx.signingPrivateKeyHex);

  const updateRes = await c.query<{ resolved_at: Date }>(
    `UPDATE trivia_matches
     SET state = 'RESOLVED', winner_email = $1, signature = $2, resolved_at = now()
     WHERE id = $3
     RETURNING resolved_at`,
    [winnerEmail, signature, matchId],
  );
  const resolvedAt = updateRes.rows[0].resolved_at;

  // Step 10: Return result
  return {
    winner_email: winnerEmail,
    signature,
    resolved_at: resolvedAt,
    session_status: sessionStatus,
    bankroll_remaining: newBankroll,
    closed_at: closedAt,
  };
}
