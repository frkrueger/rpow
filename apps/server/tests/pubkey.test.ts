import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('GET /.well-known/rpow-pubkey.pem', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns the configured public key as PEM', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/.well-known/rpow-pubkey.pem' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/x-pem-file/);
    expect(res.body).toMatch(/-----BEGIN PUBLIC KEY-----/);
  });
});
