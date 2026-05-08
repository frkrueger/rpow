import { describe, it, expect } from 'vitest';
import { generateKeypair, signTokenPayload, verifyTokenPayload } from '../src/signing.js';

describe('Ed25519 token signing', () => {
  it('signs and verifies a payload', () => {
    const kp = generateKeypair();
    const payload = { id: 'tok-1', owner_email_hash: 'aaa', value: 1n, issued_at: '2026-05-07T00:00:00Z' };
    const sig = signTokenPayload(payload, kp.privateHex);
    expect(verifyTokenPayload(payload, sig, kp.publicHex)).toBe(true);
  });
  it('rejects a tampered payload', () => {
    const kp = generateKeypair();
    const payload = { id: 'tok-1', owner_email_hash: 'aaa', value: 1n, issued_at: '2026-05-07T00:00:00Z' };
    const sig = signTokenPayload(payload, kp.privateHex);
    expect(verifyTokenPayload({ ...payload, value: 2n }, sig, kp.publicHex)).toBe(false);
  });
});
