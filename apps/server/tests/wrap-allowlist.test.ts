import { describe, it, expect } from 'vitest';
import { parseAllowlist, isAllowed } from '../src/wrap-allowlist.js';

describe('wrap-allowlist', () => {
  it('parses comma-separated emails, lowercased, trimmed', () => {
    const list = parseAllowlist(' Alice@Example.com ,  bob@test.io ,carol@x.io ');
    expect(list.kind).toBe('list');
    if (list.kind !== 'list') throw new Error('expected list kind');
    expect(list.emails.size).toBe(3);
    expect(list.emails.has('alice@example.com')).toBe(true);
    expect(list.emails.has('bob@test.io')).toBe(true);
  });

  it('handles empty / whitespace-only string', () => {
    for (const csv of ['', '   ', ',']) {
      const list = parseAllowlist(csv);
      expect(list.kind).toBe('list');
      if (list.kind !== 'list') throw new Error('expected list kind');
      expect(list.emails.size).toBe(0);
    }
  });

  it('treats "*" as a wildcard that allows everyone', () => {
    const list = parseAllowlist('*');
    expect(list.kind).toBe('all');
    expect(isAllowed(list, 'anyone@anywhere.com')).toBe(true);
    expect(isAllowed(list, 'someone-else@whatever.io')).toBe(true);
  });

  it('isAllowed is case-insensitive', () => {
    const list = parseAllowlist('alice@example.com');
    expect(isAllowed(list, 'ALICE@example.COM')).toBe(true);
    expect(isAllowed(list, 'mallory@example.com')).toBe(false);
  });

  it('empty allowlist allows no one', () => {
    const list = parseAllowlist('');
    expect(isAllowed(list, 'anyone@x.com')).toBe(false);
  });
});
