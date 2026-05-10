import { describe, it, expect } from 'vitest';
import { drawFlip } from './randomness.js';

describe('drawFlip', () => {
  it('returns a 2-char lowercase hex string and a boolean', () => {
    const draw = drawFlip();
    expect(typeof draw.challengerWins).toBe('boolean');
    expect(draw.hex).toMatch(/^[0-9a-f]{2}$/);
  });

  it('challengerWins matches LSB of the byte represented by hex', () => {
    for (let i = 0; i < 200; i++) {
      const { challengerWins, hex } = drawFlip();
      const byte = parseInt(hex, 16);
      expect(challengerWins).toBe((byte & 1) === 1);
    }
  });

  it('observes both outcomes over many draws', () => {
    let trueSeen = false;
    let falseSeen = false;
    for (let i = 0; i < 200; i++) {
      const { challengerWins } = drawFlip();
      if (challengerWins) trueSeen = true;
      else falseSeen = true;
      if (trueSeen && falseSeen) break;
    }
    expect(trueSeen).toBe(true);
    expect(falseSeen).toBe(true);
  });
});
