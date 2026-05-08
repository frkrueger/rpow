import { describe, it, expect } from 'vitest';
import { makeUnsubToken, verifyUnsubToken } from '../src/unsub.js';

describe('unsub tokens', () => {
  const secret = 'a'.repeat(32);

  it('round-trips a normal email', () => {
    const t = makeUnsubToken('alice@example.com', secret);
    expect(verifyUnsubToken(t, secret)).toBe('alice@example.com');
  });

  it('lowercases and trims on issue', () => {
    const t = makeUnsubToken('  Alice@Example.COM  ', secret);
    expect(verifyUnsubToken(t, secret)).toBe('alice@example.com');
  });

  it('rejects a tampered signature', () => {
    const t = makeUnsubToken('alice@example.com', secret);
    const [e, sig] = t.split('.');
    const flipped = sig.slice(0, -1) + (sig.slice(-1) === 'A' ? 'B' : 'A');
    expect(verifyUnsubToken(`${e}.${flipped}`, secret)).toBeNull();
  });

  it('rejects a tampered email payload', () => {
    const t = makeUnsubToken('alice@example.com', secret);
    const [, sig] = t.split('.');
    const fakeEmailB64 = Buffer.from('mallory@example.com').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(verifyUnsubToken(`${fakeEmailB64}.${sig}`, secret)).toBeNull();
  });

  it('rejects under a different secret', () => {
    const t = makeUnsubToken('alice@example.com', secret);
    expect(verifyUnsubToken(t, 'b'.repeat(32))).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(verifyUnsubToken('', secret)).toBeNull();
    expect(verifyUnsubToken('no-dot', secret)).toBeNull();
    expect(verifyUnsubToken('a.b.c', secret)).toBeNull();
  });
});
