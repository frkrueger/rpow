import { describe, it, expect, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { createTransferCheckedInstruction } from '@solana/spl-token';

// Browsers have no global Buffer. Node (where vitest runs) does, so we remove
// it to simulate the browser and make sure our polyfill restores it.
const original = (globalThis as any).Buffer;
afterEach(() => { (globalThis as any).Buffer = original; });

const A = new PublicKey('11111111111111111111111111111111');

describe('Buffer polyfill', () => {
  it('spl-token instruction builders need a global Buffer (browser repro)', () => {
    delete (globalThis as any).Buffer;
    expect(() => createTransferCheckedInstruction(A, A, A, A, 1n, 9))
      .toThrow(/Buffer is not defined/);
  });

  it('importing ./polyfills makes them work without a native global Buffer', async () => {
    delete (globalThis as any).Buffer;
    await import('./polyfills.js');
    expect((globalThis as any).Buffer).toBeDefined();
    expect(() => createTransferCheckedInstruction(A, A, A, A, 1n, 9)).not.toThrow();
  });
});
