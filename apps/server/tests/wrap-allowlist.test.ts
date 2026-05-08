import { describe, it, expect } from 'vitest';
import { parseAllowlist, isAllowed } from '../src/wrap-allowlist.js';

describe('wrap-allowlist', () => {
  it('parses comma-separated emails, lowercased, trimmed', () => {
    const set = parseAllowlist(' Alice@Example.com ,  bob@test.io ,carol@x.io ');
    expect(set.size).toBe(3);
    expect(set.has('alice@example.com')).toBe(true);
    expect(set.has('bob@test.io')).toBe(true);
  });

  it('handles empty / whitespace-only string', () => {
    expect(parseAllowlist('').size).toBe(0);
    expect(parseAllowlist('   ').size).toBe(0);
    expect(parseAllowlist(',').size).toBe(0);
  });

  it('isAllowed is case-insensitive', () => {
    const set = parseAllowlist('alice@example.com');
    expect(isAllowed(set, 'ALICE@example.COM')).toBe(true);
    expect(isAllowed(set, 'mallory@example.com')).toBe(false);
  });
});
