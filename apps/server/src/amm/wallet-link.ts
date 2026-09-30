import { createHmac, timingSafeEqual } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

export interface LinkChallengePayload {
  email: string;
  nonce: string;       // base64url, 16 random bytes
  expiresAt: string;   // ISO 8601 UTC
}

const SEP = '|';

function payloadToString(p: LinkChallengePayload): string {
  return `${p.email}${SEP}${p.nonce}${SEP}${p.expiresAt}`;
}

function hmac(secretHex: string, body: string): Buffer {
  return createHmac('sha256', Buffer.from(secretHex, 'hex')).update(body).digest();
}

/** Serialize {payload, hmac} to a single base64url string. Self-contained,
 *  no server-side state. The HMAC seals the payload against tampering. */
export function sealEnvelope(secretHex: string, p: LinkChallengePayload): string {
  const body = payloadToString(p);
  const mac = hmac(secretHex, body).toString('base64url');
  return Buffer.from(`${body}${SEP}${mac}`, 'utf8').toString('base64url');
}

/** Parse + HMAC-verify an envelope. Throws BAD_ENVELOPE on any failure
 *  (including timing-unsafe paths — we use timingSafeEqual). */
export function openEnvelope(secretHex: string, sealed: string): LinkChallengePayload {
  let decoded: string;
  try {
    decoded = Buffer.from(sealed, 'base64url').toString('utf8');
  } catch {
    throw new Error('BAD_ENVELOPE');
  }
  const parts = decoded.split(SEP);
  if (parts.length !== 4) throw new Error('BAD_ENVELOPE');
  const [email, nonce, expiresAt, macB64] = parts;
  const body = payloadToString({ email, nonce, expiresAt });
  const expected = hmac(secretHex, body);
  let actual: Buffer;
  try { actual = Buffer.from(macB64, 'base64url'); } catch { throw new Error('BAD_ENVELOPE'); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('BAD_ENVELOPE');
  }
  return { email, nonce, expiresAt };
}

export function buildLinkMessage(p: LinkChallengePayload): string {
  return [
    'RPOW Pool — link Solana wallet to account',
    '',
    `Email: ${p.email}`,
    `Nonce: ${p.nonce}`,
    `Expires: ${p.expiresAt}`,
    '',
    'Signing this proves you control this wallet.',
    'No transaction is sent, no fees are paid.',
  ].join('\n');
}

/** ed25519 verify of a Solana signMessage signature. */
export function verifySolanaSignature(args: {
  message: string;
  signatureB58: string;
  pubkeyB58: string;
}): boolean {
  let pubkeyBytes: Uint8Array;
  try { pubkeyBytes = new PublicKey(args.pubkeyB58).toBytes(); }
  catch { return false; }

  let sigBytes: Uint8Array;
  try { sigBytes = bs58.decode(args.signatureB58); }
  catch { return false; }
  if (sigBytes.length !== 64) return false;

  return nacl.sign.detached.verify(
    new TextEncoder().encode(args.message),
    sigBytes,
    pubkeyBytes,
  );
}
