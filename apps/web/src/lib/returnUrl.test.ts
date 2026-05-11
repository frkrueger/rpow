import { describe, it, expect } from 'vitest';
import { resolveReturnTarget } from './returnUrl.js';

const allow = ['https://halstavern.net', 'http://localhost:5173'];

describe('resolveReturnTarget', () => {
  it('returns URL when origin is in the allowlist', () => {
    const u = resolveReturnTarget('https://halstavern.net/games/xyz?a=1', allow);
    expect(u).not.toBeNull();
    expect(u!.origin).toBe('https://halstavern.net');
    expect(u!.pathname).toBe('/games/xyz');
    expect(u!.searchParams.get('a')).toBe('1');
  });

  it('returns URL for the dev origin', () => {
    const u = resolveReturnTarget('http://localhost:5173/x', allow);
    expect(u?.origin).toBe('http://localhost:5173');
  });

  it('returns null when origin is not allowlisted', () => {
    expect(resolveReturnTarget('https://evil.example.com/x', allow)).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(resolveReturnTarget('not a url', allow)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(resolveReturnTarget('', allow)).toBeNull();
  });

  it('returns null for null input', () => {
    expect(resolveReturnTarget(null, allow)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(resolveReturnTarget(undefined, allow)).toBeNull();
  });

  it('rejects userinfo-spoofed URL (halstavern.net@evil.com)', () => {
    // URL.origin strips userinfo — this parses as https://evil.com
    expect(resolveReturnTarget('https://halstavern.net@evil.com/x', allow)).toBeNull();
  });

  it('rejects allowlist near-misses (different scheme)', () => {
    // halstavern.net is allowed on https only; http should be rejected.
    expect(resolveReturnTarget('http://halstavern.net/x', allow)).toBeNull();
  });

  it('rejects allowlist near-misses (subdomain)', () => {
    expect(resolveReturnTarget('https://evil.halstavern.net/x', allow)).toBeNull();
  });
});
