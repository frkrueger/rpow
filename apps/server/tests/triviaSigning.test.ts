import { describe, it, expect } from 'vitest';
import {
  signMatchPayload,
  verifyMatchPayload,
  type MatchPayload,
  generateKeypair,
} from '../src/signing.js';

const samplePayload = (): MatchPayload => ({
  id: '00000000-0000-4000-8000-000000000001',
  offerer_email_hash: 'a'.repeat(64),
  challenger_email_hash: 'b'.repeat(64),
  bet_base_units: 12345n,
  question_id: '00000000-0000-4000-8000-000000000002',
  offerer_choice_idx: 1,
  offerer_answered_at: '2026-05-11T10:00:00.123Z',
  challenger_choice_idx: 2,
  challenger_answered_at: '2026-05-11T10:00:00.456Z',
  winner_email_hash: 'a'.repeat(64),
  created_at: '2026-05-11T10:00:00.000Z',
});

describe('signMatchPayload / verifyMatchPayload', () => {
  it('signs and verifies a fully-populated payload', () => {
    const { privateHex, publicHex } = generateKeypair();
    const payload = samplePayload();
    const sig = signMatchPayload(payload, privateHex);
    expect(verifyMatchPayload(payload, sig, publicHex)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const { privateHex, publicHex } = generateKeypair();
    const payload = samplePayload();
    const sig = signMatchPayload(payload, privateHex);
    const tampered: MatchPayload = { ...payload, winner_email_hash: 'c'.repeat(64) };
    expect(verifyMatchPayload(tampered, sig, publicHex)).toBe(false);
  });

  it('supports null choice + null answered_at for a timed-out side', () => {
    const { privateHex, publicHex } = generateKeypair();
    const payload: MatchPayload = {
      ...samplePayload(),
      challenger_choice_idx: null,
      challenger_answered_at: null,
    };
    const sig = signMatchPayload(payload, privateHex);
    expect(verifyMatchPayload(payload, sig, publicHex)).toBe(true);
  });

  it('produces deterministic bytes for the same payload', () => {
    const { privateHex } = generateKeypair();
    const payload = samplePayload();
    const sig1 = signMatchPayload(payload, privateHex);
    const sig2 = signMatchPayload(payload, privateHex);
    expect(sig1.equals(sig2)).toBe(true);
  });
});
