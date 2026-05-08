import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { verifyPhantomSignature } from './wallet-verify.js';

describe('verifyPhantomSignature', () => {
  it('verifies a real ed25519 signature over a UTF-8 message', () => {
    const kp = nacl.sign.keyPair();
    const message = 'rpow2.com bind: 11111111-1111-1111-1111-111111111111';
    const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
    const ok = verifyPhantomSignature(message, bs58.encode(sig), bs58.encode(kp.publicKey));
    expect(ok).toBe(true);
  });

  it('rejects a tampered message', () => {
    const kp = nacl.sign.keyPair();
    const message = 'rpow2.com bind: a';
    const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
    const ok = verifyPhantomSignature('rpow2.com bind: b', bs58.encode(sig), bs58.encode(kp.publicKey));
    expect(ok).toBe(false);
  });

  it('rejects a wrong public key', () => {
    const kp = nacl.sign.keyPair();
    const other = nacl.sign.keyPair();
    const message = 'rpow2.com bind: x';
    const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
    const ok = verifyPhantomSignature(message, bs58.encode(sig), bs58.encode(other.publicKey));
    expect(ok).toBe(false);
  });

  it('returns false on malformed input', () => {
    expect(verifyPhantomSignature('m', 'not-base58!!!', 'also-bad')).toBe(false);
  });

  it('returns false for a valid-base58 signature of wrong length', () => {
    const kp = nacl.sign.keyPair();
    const shortSig = bs58.encode(new Uint8Array(63)); // 63 bytes, not 64
    expect(verifyPhantomSignature('m', shortSig, bs58.encode(kp.publicKey))).toBe(false);
  });

  it('returns false for a valid-base58 pubkey of wrong length', () => {
    const kp = nacl.sign.keyPair();
    const sig = nacl.sign.detached(new TextEncoder().encode('m'), kp.secretKey);
    const shortPub = bs58.encode(new Uint8Array(20)); // 20 bytes, not 32
    expect(verifyPhantomSignature('m', bs58.encode(sig), shortPub)).toBe(false);
  });
});
