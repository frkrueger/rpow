import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('GET /srpow/config', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns public unwrap configuration without auth', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/srpow/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      fee_bps: 500,
      min_unwrap_base_units: '10000000000',
      slippage_bps: 1000,
    });
    expect(typeof body.bridge_wallet_pubkey).toBe('string');
    expect(typeof body.srpow_mint_address).toBe('string');
    expect(typeof body.max_unwrap_base_units).toBe('string');
  });
});
