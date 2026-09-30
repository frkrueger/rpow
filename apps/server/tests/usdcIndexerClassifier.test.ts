import { describe, it, expect } from 'vitest';
import { extractUsdcTransfersTo } from '../src/amm/usdc-indexer-classifier.js';

const AMM_ATA = '9wVgJE1iKnBS8FiSnHc7jXv5Lz6uD819UYxwu7QAxxSp';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function txWith(instructions: any[], inner: any[] = []): any {
  return {
    transaction: { message: { instructions } },
    meta: {
      innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [],
    },
  };
}

describe('extractUsdcTransfersTo', () => {
  it('extracts top-level transferChecked to the AMM ATA', () => {
    const tx = txWith([
      { program: 'spl-token', parsed: {
        type: 'transferChecked',
        info: { source: 'SRC', destination: AMM_ATA, authority: 'SENDER1', mint: USDC, tokenAmount: { amount: '12345' } },
      } },
    ]);
    expect(extractUsdcTransfersTo(tx, AMM_ATA, USDC)).toEqual([
      { amount: 12345n, authority: 'SENDER1' },
    ]);
  });

  it('extracts plain transfer to the AMM ATA (no mint field; ATA filter is enough)', () => {
    const tx = txWith([
      { program: 'spl-token', parsed: {
        type: 'transfer',
        info: { source: 'SRC', destination: AMM_ATA, authority: 'SENDER2', amount: '500' },
      } },
    ]);
    expect(extractUsdcTransfersTo(tx, AMM_ATA, USDC)).toEqual([
      { amount: 500n, authority: 'SENDER2' },
    ]);
  });

  it('handles CPI inner-instruction transfers (Jupiter-routed swaps to our ATA)', () => {
    const tx = txWith(
      [{ program: 'unknown', parsed: { type: 'unknown' } }],
      [{ program: 'spl-token', parsed: {
        type: 'transferChecked',
        info: { source: 'SRC', destination: AMM_ATA, authority: 'SENDER3', mint: USDC, tokenAmount: { amount: '777' } },
      } }],
    );
    expect(extractUsdcTransfersTo(tx, AMM_ATA, USDC)).toEqual([
      { amount: 777n, authority: 'SENDER3' },
    ]);
  });

  it('ignores transferChecked with a non-USDC mint', () => {
    const tx = txWith([
      { program: 'spl-token', parsed: {
        type: 'transferChecked',
        info: {
          source: 'SRC', destination: AMM_ATA, authority: 'SENDER',
          mint: 'NotUSDCMint11111111111111111111111111111111',
          tokenAmount: { amount: '1' },
        },
      } },
    ]);
    expect(extractUsdcTransfersTo(tx, AMM_ATA, USDC)).toEqual([]);
  });

  it('ignores transfers to other ATAs', () => {
    const tx = txWith([
      { program: 'spl-token', parsed: {
        type: 'transfer',
        info: { source: 'SRC', destination: 'NotOurAta11111111111111111111111111111111', authority: 'X', amount: '1' },
      } },
    ]);
    expect(extractUsdcTransfersTo(tx, AMM_ATA, USDC)).toEqual([]);
  });

  it('accepts spl-token-2022 program ID alongside spl-token', () => {
    const tx = txWith([
      { program: 'spl-token-2022', parsed: {
        type: 'transferChecked',
        info: { source: 'SRC', destination: AMM_ATA, authority: 'SENDER22', mint: USDC, tokenAmount: { amount: '9' } },
      } },
    ]);
    expect(extractUsdcTransfersTo(tx, AMM_ATA, USDC)).toEqual([
      { amount: 9n, authority: 'SENDER22' },
    ]);
  });

  it('extracts multiple matching instructions in one tx', () => {
    const tx = txWith([
      { program: 'spl-token', parsed: { type: 'transferChecked',
        info: { source: 'A', destination: AMM_ATA, authority: 'S1', mint: USDC, tokenAmount: { amount: '1' } } } },
      { program: 'spl-token', parsed: { type: 'transferChecked',
        info: { source: 'B', destination: AMM_ATA, authority: 'S2', mint: USDC, tokenAmount: { amount: '2' } } } },
    ]);
    expect(extractUsdcTransfersTo(tx, AMM_ATA, USDC)).toEqual([
      { amount: 1n, authority: 'S1' },
      { amount: 2n, authority: 'S2' },
    ]);
  });

  it('returns [] for tx with no instructions', () => {
    expect(extractUsdcTransfersTo(txWith([]), AMM_ATA, USDC)).toEqual([]);
  });
});
