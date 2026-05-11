import { generateKeyPairSync, sign, verify, createPrivateKey, createPublicKey } from 'node:crypto';

export interface TokenPayload {
  id: string;
  owner_email_hash: string;
  value: bigint;
  issued_at: string;
}

export function generateKeypair(): { privateHex: string; publicHex: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // Raw 32-byte keys (DER-stripped)
  const privRaw = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateHex: privRaw.toString('hex'), publicHex: pubRaw.toString('hex') };
}

function privKeyFromHex(hex: string) {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(hex, 'hex')]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function pubKeyFromHex(hex: string) {
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function canonical(payload: TokenPayload): Buffer {
  const ordered = JSON.stringify(
    {
      id: payload.id, owner_email_hash: payload.owner_email_hash, value: payload.value, issued_at: payload.issued_at,
    },
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
  return Buffer.from(ordered, 'utf8');
}

export function signTokenPayload(payload: TokenPayload, privHex: string): Buffer {
  return sign(null, canonical(payload), privKeyFromHex(privHex));
}

export function verifyTokenPayload(payload: TokenPayload, sig: Buffer, pubHex: string): boolean {
  return verify(null, canonical(payload), pubKeyFromHex(pubHex), sig);
}

export interface FlipPayload {
  id: string;
  offerer_email_hash: string;
  challenger_email_hash: string;
  bet_base_units: bigint;
  winner_email_hash: string;
  random_value_hex: string;
  created_at: string;
}

function canonicalFlip(payload: FlipPayload): Buffer {
  const ordered = JSON.stringify(
    {
      id: payload.id,
      offerer_email_hash: payload.offerer_email_hash,
      challenger_email_hash: payload.challenger_email_hash,
      bet_base_units: payload.bet_base_units,
      winner_email_hash: payload.winner_email_hash,
      random_value_hex: payload.random_value_hex,
      created_at: payload.created_at,
    },
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
  return Buffer.from(ordered, 'utf8');
}

export function signFlipPayload(payload: FlipPayload, privHex: string): Buffer {
  return sign(null, canonicalFlip(payload), privKeyFromHex(privHex));
}

export function verifyFlipPayload(payload: FlipPayload, sig: Buffer, pubHex: string): boolean {
  return verify(null, canonicalFlip(payload), pubKeyFromHex(pubHex), sig);
}

export interface MatchPayload {
  id: string;
  offerer_email_hash: string;
  challenger_email_hash: string;
  bet_base_units: bigint;
  question_id: string;
  offerer_choice_idx: number | null;
  offerer_answered_at: string | null;
  challenger_choice_idx: number | null;
  challenger_answered_at: string | null;
  winner_email_hash: string;
  created_at: string;
}

function canonicalMatch(payload: MatchPayload): Buffer {
  // Field order is part of the contract — never reorder, never add fields
  // in place; new versions get a new payload type.
  const ordered = JSON.stringify(
    {
      id: payload.id,
      offerer_email_hash: payload.offerer_email_hash,
      challenger_email_hash: payload.challenger_email_hash,
      bet_base_units: payload.bet_base_units,
      question_id: payload.question_id,
      offerer_choice_idx: payload.offerer_choice_idx,
      offerer_answered_at: payload.offerer_answered_at,
      challenger_choice_idx: payload.challenger_choice_idx,
      challenger_answered_at: payload.challenger_answered_at,
      winner_email_hash: payload.winner_email_hash,
      created_at: payload.created_at,
    },
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
  return Buffer.from(ordered, 'utf8');
}

export function signMatchPayload(payload: MatchPayload, privHex: string): Buffer {
  return sign(null, canonicalMatch(payload), privKeyFromHex(privHex));
}

export function verifyMatchPayload(payload: MatchPayload, sig: Buffer, pubHex: string): boolean {
  return verify(null, canonicalMatch(payload), pubKeyFromHex(pubHex), sig);
}

export interface SwapPayload {
  id: string;
  account_email_hash: string;
  direction: 'BUY' | 'SELL';
  rpow_delta_base_units: bigint;
  usdc_delta_base_units: bigint;
  fee_base_units: bigint;
  pool_rpow_after: bigint;
  pool_usdc_after: bigint;
  created_at: string;
}

function canonicalSwap(payload: SwapPayload): Buffer {
  // Field order is part of the contract — never reorder, never add fields
  // in place; new versions get a new payload type.
  const ordered = JSON.stringify(
    {
      id: payload.id,
      account_email_hash: payload.account_email_hash,
      direction: payload.direction,
      rpow_delta_base_units: payload.rpow_delta_base_units,
      usdc_delta_base_units: payload.usdc_delta_base_units,
      fee_base_units: payload.fee_base_units,
      pool_rpow_after: payload.pool_rpow_after,
      pool_usdc_after: payload.pool_usdc_after,
      created_at: payload.created_at,
    },
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
  return Buffer.from(ordered, 'utf8');
}

export function signSwapPayload(payload: SwapPayload, privHex: string): Buffer {
  return sign(null, canonicalSwap(payload), privKeyFromHex(privHex));
}

export function verifySwapPayload(payload: SwapPayload, sig: Buffer, pubHex: string): boolean {
  return verify(null, canonicalSwap(payload), pubKeyFromHex(pubHex), sig);
}
