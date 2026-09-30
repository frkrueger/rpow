import { describe, it, expect } from 'vitest';
import {
  signLpEventPayload,
  verifyLpEventPayload,
  type LpEventPayload,
  generateKeypair,
} from '../src/signing.js';

const sample = (): LpEventPayload => ({
  id: '00000000-0000-4000-8000-000000000001',
  account_email_hash: 'a'.repeat(64),
  type: 'ADD',
  rpow_delta_base_units: -1_000_000_000n,
  usdc_delta_base_units: -10_000_000n,
  lp_delta_base_units: 12_345n,
  pool_rpow_after: 11_000_000_000n,
  pool_usdc_after: 110_000_000n,
  total_lp_after: 31_634_899_945n,
  created_at: '2026-05-11T17:00:00.000Z',
});

describe('signLpEventPayload / verifyLpEventPayload', () => {
  it('signs and verifies an ADD payload', () => {
    const { privateHex, publicHex } = generateKeypair();
    const p = sample();
    const sig = signLpEventPayload(p, privateHex);
    expect(verifyLpEventPayload(p, sig, publicHex)).toBe(true);
  });

  it('signs and verifies a REMOVE payload', () => {
    const { privateHex, publicHex } = generateKeypair();
    const p: LpEventPayload = { ...sample(), type: 'REMOVE', rpow_delta_base_units: 1_000_000_000n, usdc_delta_base_units: 10_000_000n, lp_delta_base_units: -12_345n };
    const sig = signLpEventPayload(p, privateHex);
    expect(verifyLpEventPayload(p, sig, publicHex)).toBe(true);
  });

  it('rejects tampered type', () => {
    const { privateHex, publicHex } = generateKeypair();
    const p = sample();
    const sig = signLpEventPayload(p, privateHex);
    expect(verifyLpEventPayload({ ...p, type: 'REMOVE' }, sig, publicHex)).toBe(false);
  });

  it('rejects tampered lp_delta', () => {
    const { privateHex, publicHex } = generateKeypair();
    const p = sample();
    const sig = signLpEventPayload(p, privateHex);
    expect(verifyLpEventPayload({ ...p, lp_delta_base_units: 0n }, sig, publicHex)).toBe(false);
  });

  it('deterministic', () => {
    const { privateHex } = generateKeypair();
    const p = sample();
    expect(signLpEventPayload(p, privateHex).equals(signLpEventPayload(p, privateHex))).toBe(true);
  });
});
