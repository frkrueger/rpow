import { describe, it, expect } from 'vitest';
import { fetchDrawEntropy } from '../src/freelottery/solanaBlock.js';

function makeFetch(handlers: Array<(body: any) => any>): typeof fetch {
  let i = 0;
  return (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const handler = handlers[i++];
    if (!handler) throw new Error('no more mocked fetches');
    const result = handler(body);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('fetchDrawEntropy', () => {
  it('returns { slot, blockhash } from getSlot + getBlock RPC calls', async () => {
    const fetchImpl = makeFetch([
      (body) => {
        expect(body.method).toBe('getSlot');
        return { jsonrpc: '2.0', id: body.id, result: 123_456_789 };
      },
      (body) => {
        expect(body.method).toBe('getBlock');
        expect(body.params[0]).toBe(123_456_789);
        return {
          jsonrpc: '2.0', id: body.id,
          result: { blockhash: 'GfDfgkABCDEFghijklmnopqrstuvwxyz0123456789ab' },
        };
      },
    ]);

    const out = await fetchDrawEntropy({ rpcUrl: 'http://test.local', fetchImpl });
    expect(out).toEqual({ slot: 123_456_789, blockhash: 'GfDfgkABCDEFghijklmnopqrstuvwxyz0123456789ab' });
  });

  it('throws when rpcUrl is missing', async () => {
    await expect(fetchDrawEntropy({ rpcUrl: '', fetchImpl: makeFetch([]) })).rejects.toThrow(/rpcUrl/);
  });

  it('throws when getSlot RPC returns an error', async () => {
    const fetchImpl = makeFetch([
      (body) => ({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }),
    ]);
    await expect(fetchDrawEntropy({ rpcUrl: 'http://test.local', fetchImpl })).rejects.toThrow(/Method not found|RPC error/);
  });

  it('throws when getBlock returns null (slot skipped)', async () => {
    const fetchImpl = makeFetch([
      (body) => ({ jsonrpc: '2.0', id: body.id, result: 100 }),
      (body) => ({ jsonrpc: '2.0', id: body.id, result: null }),
    ]);
    await expect(fetchDrawEntropy({ rpcUrl: 'http://test.local', fetchImpl })).rejects.toThrow(/null|skipped|no block/i);
  });
});
