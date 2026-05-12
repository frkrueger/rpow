export interface DrawEntropy {
  slot: number;
  blockhash: string;
}

export interface FetchDrawEntropyOpts {
  rpcUrl: string;
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
}

async function rpcCall<T>(rpcUrl: string, fetchImpl: typeof fetch, method: string, params: unknown[]): Promise<T> {
  const id = Math.floor(Math.random() * 1_000_000);
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} for ${method}`);
  const json = await res.json() as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`RPC error ${method}: ${json.error.message}`);
  return json.result as T;
}

/**
 * Fetches the current Solana slot and its blockhash. The values are recorded
 * on the `freelottery_draws` row so anyone can re-verify the draw winner.
 *
 * Note: this picks "the block our server saw at draw-processing time," which
 * is deterministic once recorded (the slot+blockhash pair is immutable on
 * Solana). It's not strictly "the first block at-or-after 19:00 UTC" — the
 * scheduler tick runs every 60s, so processing typically happens within 60s
 * of 19:00 UTC. Operator-rigging is prevented because the operator does not
 * know the next block hash when entries close.
 */
export async function fetchDrawEntropy(opts: FetchDrawEntropyOpts): Promise<DrawEntropy> {
  if (!opts.rpcUrl) throw new Error('rpcUrl is required');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const slot = await rpcCall<number>(opts.rpcUrl, fetchImpl, 'getSlot', [{ commitment: 'finalized' }]);
  const block = await rpcCall<{ blockhash: string } | null>(
    opts.rpcUrl,
    fetchImpl,
    'getBlock',
    [slot, { transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }],
  );
  if (!block) throw new Error(`no block for slot ${slot} (skipped slot)`);
  return { slot, blockhash: block.blockhash };
}
