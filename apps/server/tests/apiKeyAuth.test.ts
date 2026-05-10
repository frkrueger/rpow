import { describe, it, expect } from 'vitest';
import { hashApiKey } from '../src/routes/auth.js';

describe('hashApiKey', () => {
  it('returns a 32-byte buffer (sha256)', () => {
    const h = hashApiKey('rpow_sk_abc');
    expect(h).toBeInstanceOf(Buffer);
    expect(h.length).toBe(32);
  });

  it('is deterministic', () => {
    const a = hashApiKey('rpow_sk_xyz');
    const b = hashApiKey('rpow_sk_xyz');
    expect(a.equals(b)).toBe(true);
  });

  it('differs across distinct inputs', () => {
    const a = hashApiKey('rpow_sk_a');
    const b = hashApiKey('rpow_sk_b');
    expect(a.equals(b)).toBe(false);
  });
});
