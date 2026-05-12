import { describe, it, expect } from 'vitest';
import {
  getDayUtc,
  dayIndex,
  nextDrawAt,
  hasStarted,
  hasEnded,
} from '../src/freelottery/schedule.js';

const CFG = {
  startUtcDate: '2026-05-13',
  totalDays: 100,
  drawHourUtc: 19,
};

describe('freelottery schedule', () => {
  describe('getDayUtc', () => {
    it('returns the upcoming draw date when before 19:00 UTC', () => {
      // 2026-05-13 17:00 UTC → day_utc still 2026-05-13 (entry window closes today at 19:00).
      expect(getDayUtc(new Date('2026-05-13T17:00:00Z'), CFG)).toBe('2026-05-13');
    });

    it('returns the next date when at-or-after 19:00 UTC', () => {
      // 2026-05-13 19:00 UTC → window for 2026-05-13 closed; next day_utc is 2026-05-14.
      expect(getDayUtc(new Date('2026-05-13T19:00:00Z'), CFG)).toBe('2026-05-14');
    });

    it('returns null before the campaign starts', () => {
      expect(getDayUtc(new Date('2026-05-12T17:00:00Z'), CFG)).toBeNull();
    });

    it('returns null after the campaign ends', () => {
      // Day 100 closes at 2026-08-20 19:00. After that, no more days.
      expect(getDayUtc(new Date('2026-08-20T20:00:00Z'), CFG)).toBeNull();
    });
  });

  describe('dayIndex', () => {
    it('is 1 on the first day', () => {
      expect(dayIndex('2026-05-13', CFG)).toBe(1);
    });

    it('is 100 on the last day', () => {
      expect(dayIndex('2026-08-20', CFG)).toBe(100);
    });

    it('returns null outside the campaign window', () => {
      expect(dayIndex('2026-05-12', CFG)).toBeNull();
      expect(dayIndex('2026-08-21', CFG)).toBeNull();
    });
  });

  describe('nextDrawAt', () => {
    it('returns today 19:00 UTC when before 19:00', () => {
      expect(nextDrawAt(new Date('2026-05-13T17:00:00Z'), CFG)?.toISOString())
        .toBe('2026-05-13T19:00:00.000Z');
    });

    it('returns tomorrow 19:00 UTC when at/after 19:00', () => {
      expect(nextDrawAt(new Date('2026-05-13T19:00:00Z'), CFG)?.toISOString())
        .toBe('2026-05-14T19:00:00.000Z');
    });

    it('returns null after the campaign ends', () => {
      expect(nextDrawAt(new Date('2026-08-21T00:00:00Z'), CFG)).toBeNull();
    });
  });

  describe('hasStarted / hasEnded', () => {
    // Per spec §8 and §11 step 5, entries are accepted from feature-enable time
    // through the day-100 close. So hasStarted is true whenever the campaign is
    // configured and not yet ended — even before the day-1 draw.
    it('hasStarted is true once enabled, even before day-1 close', () => {
      expect(hasStarted(new Date('2026-05-12T00:00:00Z'), CFG)).toBe(true);
    });

    it('hasEnded is true at the exact moment day-100 closes', () => {
      expect(hasEnded(new Date('2026-08-20T19:00:00Z'), CFG)).toBe(true);
      expect(hasEnded(new Date('2026-08-20T18:59:59Z'), CFG)).toBe(false);
    });
  });

  describe('disabled config', () => {
    it('every function returns null/false when startUtcDate is undefined', () => {
      const off = { startUtcDate: undefined, totalDays: 100, drawHourUtc: 19 };
      expect(getDayUtc(new Date(), off)).toBeNull();
      expect(nextDrawAt(new Date(), off)).toBeNull();
      expect(dayIndex('2026-05-13', off)).toBeNull();
      expect(hasStarted(new Date(), off)).toBe(false);
      expect(hasEnded(new Date(), off)).toBe(true);
    });
  });
});
