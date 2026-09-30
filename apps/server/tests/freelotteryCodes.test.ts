import { describe, it, expect } from 'vitest';
import {
  generateCode,
  ticketCountForBalance,
  tweetTemplate,
  tweetIntentUrl,
  BASE_UNITS_PER_RPOW,
} from '../src/freelottery/codes.js';

describe('freelottery codes', () => {
  describe('generateCode', () => {
    it('returns 6-digit numeric string', () => {
      for (let i = 0; i < 100; i++) {
        const code = generateCode();
        expect(code).toMatch(/^\d{6}$/);
      }
    });

    it('produces varying values (not constant)', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 50; i++) seen.add(generateCode());
      expect(seen.size).toBeGreaterThan(1);
    });
  });

  describe('ticketCountForBalance', () => {
    it('1 ticket when balance is zero', () => {
      expect(ticketCountForBalance(0n)).toBe(1);
    });

    it('1 ticket when balance is just below 1 RPOW', () => {
      expect(ticketCountForBalance(BASE_UNITS_PER_RPOW - 1n)).toBe(1);
    });

    it('2 tickets when balance is exactly 1 RPOW', () => {
      expect(ticketCountForBalance(BASE_UNITS_PER_RPOW)).toBe(2);
    });

    it('2 tickets when balance is many RPOW', () => {
      expect(ticketCountForBalance(BASE_UNITS_PER_RPOW * 1000n)).toBe(2);
    });
  });

  describe('tweetTemplate', () => {
    it('embeds the code verbatim', () => {
      expect(tweetTemplate('123456')).toContain('My code is 123456');
    });

    it('mentions the prize and the URL', () => {
      const t = tweetTemplate('000000');
      expect(t).toContain('1000 RPOW');
      expect(t).toContain('freelottery.rpow2.com');
    });
  });

  describe('tweetIntentUrl', () => {
    it('returns a twitter intent URL with URL-encoded text', () => {
      const url = tweetIntentUrl('123456');
      expect(url).toMatch(/^https:\/\/twitter\.com\/intent\/tweet\?text=/);
      expect(decodeURIComponent(url.split('text=')[1])).toBe(tweetTemplate('123456'));
    });
  });
});
