import { describe, it, expect } from 'vitest';
import {
  signSwapPayload,
  verifySwapPayload,
  type SwapPayload,
  generateKeypair,
} from '../src/signing.js';

const samplePayload = (): SwapPayload => ({
  id: '00000000-0000-4000-8000-000000000001',
  account_email_hash: 'a'.repeat(64),
  direction: 'BUY',
  rpow_delta_base_units: 1_000_000_000n,
  usdc_delta_base_units: 10_000_000n,
  fee_base_units: 30_000n,
  pool_rpow_after: 9_000_000_000_000n,
  pool_usdc_after: 110_000_000n,
  created_at: '2026-05-11T16:00:00.000Z',
});

describe('signSwapPayload / verifySwapPayload', () => {
  it('signs and verifies a BUY payload', () => {
    const { privateHex, publicHex } = generateKeypair();
    const p = samplePayload();
    const sig = signSwapPayload(p, privateHex);
    expect(verifySwapPayload(p, sig, publicHex)).toBe(true);
  });

  it('signs and verifies a SELL payload', () => {
    const { privateHex, publicHex } = generateKeypair();
    const p: SwapPayload = { ...samplePayload(), direction: 'SELL' };
    const sig = signSwapPayload(p, privateHex);
    expect(verifySwapPayload(p, sig, publicHex)).toBe(true);
  });

  it('rejects a tampered payload (direction flipped)', () => {
    const { privateHex, publicHex } = generateKeypair();
    const p = samplePayload();
    const sig = signSwapPayload(p, privateHex);
    const tampered: SwapPayload = { ...p, direction: 'SELL' };
    expect(verifySwapPayload(tampered, sig, publicHex)).toBe(false);
  });

  it('rejects a tampered payload (fee changed)', () => {
    const { privateHex, publicHex } = generateKeypair();
    const p = samplePayload();
    const sig = signSwapPayload(p, privateHex);
    const tampered: SwapPayload = { ...p, fee_base_units: 0n };
    expect(verifySwapPayload(tampered, sig, publicHex)).toBe(false);
  });

  it('deterministic (ed25519): same payload → same signature bytes', () => {
    const { privateHex } = generateKeypair();
    const p = samplePayload();
    const s1 = signSwapPayload(p, privateHex);
    const s2 = signSwapPayload(p, privateHex);
    expect(s1.equals(s2)).toBe(true);
  });
});
