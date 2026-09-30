import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  buildLinkMessage,
  sealEnvelope,
  openEnvelope,
  verifySolanaSignature,
} from '../src/amm/wallet-link.js';

const SECRET = 'a'.repeat(64);

describe('wallet-link helpers', () => {
  it('seal/open envelope roundtrip succeeds for unmodified payload', () => {
    const sealed = sealEnvelope(SECRET, {
      email: 'a@x.com', nonce: 'NONCE1', expiresAt: '2026-05-12T00:00:00.000Z',
    });
    const opened = openEnvelope(SECRET, sealed);
    expect(opened).toEqual({
      email: 'a@x.com', nonce: 'NONCE1', expiresAt: '2026-05-12T00:00:00.000Z',
    });
  });

  it('openEnvelope rejects tampered HMAC', () => {
    const sealed = sealEnvelope(SECRET, {
      email: 'a@x.com', nonce: 'NONCE1', expiresAt: '2026-05-12T00:00:00.000Z',
    });
    const tampered = sealed.slice(0, -2) + 'AA';
    expect(() => openEnvelope(SECRET, tampered)).toThrow(/BAD_ENVELOPE/);
  });

  it('openEnvelope rejects payload signed with a different secret', () => {
    const sealed = sealEnvelope(SECRET, {
      email: 'a@x.com', nonce: 'NONCE1', expiresAt: '2026-05-12T00:00:00.000Z',
    });
    expect(() => openEnvelope('b'.repeat(64), sealed)).toThrow(/BAD_ENVELOPE/);
  });

  it('buildLinkMessage is stable and human-readable', () => {
    const msg = buildLinkMessage({
      email: 'a@x.com', nonce: 'NONCE1', expiresAt: '2026-05-12T00:00:00.000Z',
    });
    expect(msg).toContain('RPOW Pool');
    expect(msg).toContain('a@x.com');
    expect(msg).toContain('NONCE1');
    expect(msg).toContain('2026-05-12T00:00:00.000Z');
  });

  it('verifySolanaSignature accepts a real keypair signature over the message', async () => {
    const kp = Keypair.generate();
    const message = buildLinkMessage({
      email: 'a@x.com', nonce: 'NONCE1', expiresAt: '2026-05-12T00:00:00.000Z',
    });
    const messageBytes = new TextEncoder().encode(message);
    const nacl = await import('tweetnacl');
    const sig = nacl.default.sign.detached(messageBytes, kp.secretKey);

    expect(verifySolanaSignature({
      message,
      signatureB58: bs58.encode(sig),
      pubkeyB58: kp.publicKey.toBase58(),
    })).toBe(true);
  });

  it('verifySolanaSignature rejects when signature is from a different key', async () => {
    const kp1 = Keypair.generate();
    const kp2 = Keypair.generate();
    const message = 'hello';
    const nacl = await import('tweetnacl');
    const sig = nacl.default.sign.detached(new TextEncoder().encode(message), kp1.secretKey);
    expect(verifySolanaSignature({
      message,
      signatureB58: bs58.encode(sig),
      pubkeyB58: kp2.publicKey.toBase58(),
    })).toBe(false);
  });
});
