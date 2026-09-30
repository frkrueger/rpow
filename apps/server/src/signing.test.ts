import { describe, it, expect } from 'vitest';
import { generateKeypair, signFlipPayload, verifyFlipPayload, type FlipPayload } from './signing.js';

describe('FlipPayload signing', () => {
  const { privateHex, publicHex } = generateKeypair();

  const samplePayload: FlipPayload = {
    id: '11111111-1111-1111-1111-111111111111',
    offerer_email_hash: 'a'.repeat(64),
    challenger_email_hash: 'b'.repeat(64),
    bet_base_units: 100_000_000n,
    winner_email_hash: 'a'.repeat(64),
    random_value_hex: 'ff',
    created_at: '2026-05-10T12:00:00.000Z',
  };

  it('signFlipPayload + verifyFlipPayload round-trip', () => {
    const sig = signFlipPayload(samplePayload, privateHex);
    expect(verifyFlipPayload(samplePayload, sig, publicHex)).toBe(true);
  });

  it('verifyFlipPayload rejects a tampered field', () => {
    const sig = signFlipPayload(samplePayload, privateHex);
    const tampered = { ...samplePayload, bet_base_units: 200_000_000n };
    expect(verifyFlipPayload(tampered, sig, publicHex)).toBe(false);
  });

  it('verifyFlipPayload rejects under a different public key', () => {
    const other = generateKeypair();
    const sig = signFlipPayload(samplePayload, privateHex);
    expect(verifyFlipPayload(samplePayload, sig, other.publicHex)).toBe(false);
  });

  it('canonicalization is stable across property-order permutations', () => {
    const reordered: FlipPayload = {
      created_at: samplePayload.created_at,
      random_value_hex: samplePayload.random_value_hex,
      winner_email_hash: samplePayload.winner_email_hash,
      bet_base_units: samplePayload.bet_base_units,
      challenger_email_hash: samplePayload.challenger_email_hash,
      offerer_email_hash: samplePayload.offerer_email_hash,
      id: samplePayload.id,
    };
    const sigA = signFlipPayload(samplePayload, privateHex);
    const sigB = signFlipPayload(reordered, privateHex);
    expect(sigA.equals(sigB)).toBe(true);
  });
});
