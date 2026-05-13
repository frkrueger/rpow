import { describe, it, expect } from 'vitest';
import { isDisposableEmail, normalizeEmail, BLOCKED_DOMAINS } from '../src/disposable-domains.js';

describe('isDisposableEmail', () => {
  it('returns true for known bot-farm domains', () => {
    expect(isDisposableEmail('foo@wshu.net')).toBe(true);
    expect(isDisposableEmail('bar@tambatamsau.com')).toBe(true);
    expect(isDisposableEmail('baz@issue0x.com')).toBe(true);
  });

  it('returns true for known disposable services', () => {
    expect(isDisposableEmail('joe@mailinator.com')).toBe(true);
    expect(isDisposableEmail('joe@10minutemail.com')).toBe(true);
  });

  it('is case-insensitive on the domain', () => {
    expect(isDisposableEmail('Joe@MaiLiNaToR.cOm')).toBe(true);
  });

  it('returns false for mainstream provider domains', () => {
    expect(isDisposableEmail('alice@gmail.com')).toBe(false);
    expect(isDisposableEmail('bob@yahoo.com')).toBe(false);
    expect(isDisposableEmail('carol@outlook.com')).toBe(false);
    expect(isDisposableEmail('dmitry@rambler.ru')).toBe(false);
    expect(isDisposableEmail('lin@qq.com')).toBe(false);
  });

  it('returns false for malformed inputs', () => {
    expect(isDisposableEmail('no-at-sign')).toBe(false);
    expect(isDisposableEmail('')).toBe(false);
  });

  it('does not over-match on subdomains (apex-only)', () => {
    // We intentionally don't wildcard-match. Bot operators use apex domains;
    // expanding to subdomains risks false positives if a real provider hosts
    // a subdomain that happens to share suffix.
    expect(isDisposableEmail('foo@bar.wshu.net')).toBe(false);
  });

  it('exports a non-empty blocklist', () => {
    expect(BLOCKED_DOMAINS.size).toBeGreaterThan(20);
  });
});

describe('normalizeEmail', () => {
  it('strips Gmail +tags', () => {
    expect(normalizeEmail('foo+a@gmail.com')).toBe('foo@gmail.com');
    expect(normalizeEmail('foo+anything.here@gmail.com')).toBe('foo@gmail.com');
    expect(normalizeEmail('zhet10001+rpow123@gmail.com')).toBe('zhet10001@gmail.com');
  });

  it('strips +tags for googlemail.com too (same provider)', () => {
    expect(normalizeEmail('foo+a@googlemail.com')).toBe('foo@googlemail.com');
  });

  it('leaves +tags alone on non-Gmail providers (semantics differ)', () => {
    expect(normalizeEmail('foo+a@protonmail.com')).toBe('foo+a@protonmail.com');
    expect(normalizeEmail('foo+a@yahoo.com')).toBe('foo+a@yahoo.com');
  });

  it('lowercases and trims', () => {
    expect(normalizeEmail('  Foo+TAG@Gmail.com  ')).toBe('foo@gmail.com');
  });

  it('is a no-op when there is no +tag', () => {
    expect(normalizeEmail('foo@gmail.com')).toBe('foo@gmail.com');
  });

  it('handles malformed input gracefully', () => {
    expect(normalizeEmail('no-at-sign')).toBe('no-at-sign');
    expect(normalizeEmail('')).toBe('');
  });
});
