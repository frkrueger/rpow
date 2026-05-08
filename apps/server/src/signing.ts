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
