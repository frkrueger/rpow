import { describe, it, expect } from 'vitest';
import { SUPPLY_SHARD_COUNT, pickSupplyShard } from '../src/supplyShards.js';

describe('supplyShards', () => {
  it('SUPPLY_SHARD_COUNT is 16', () => {
    expect(SUPPLY_SHARD_COUNT).toBe(16);
  });

  it('pickSupplyShard returns 0..15', () => {
    for (let i = 0; i < 1000; i++) {
      const s = pickSupplyShard();
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(16);
      expect(Number.isInteger(s)).toBe(true);
    }
  });

  it('pickSupplyShard distribution covers all 16 shards over 10k draws', () => {
    const hits = new Set<number>();
    for (let i = 0; i < 10_000; i++) hits.add(pickSupplyShard());
    expect(hits.size).toBe(16);
  });
});
