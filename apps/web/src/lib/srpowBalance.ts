export interface FetchSrpowBalanceArgs {
  rpcUrl: string;       // VITE_SOLANA_RPC_URL (proxy)
  ownerPubkey: string;
  mintPubkey: string;
}

export async function fetchSrpowBalanceBaseUnits(args: FetchSrpowBalanceArgs): Promise<bigint> {
  const res = await fetch(args.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
      params: [
        args.ownerPubkey,
        { mint: args.mintPubkey },
        { encoding: 'jsonParsed', commitment: 'finalized' },
      ],
    }),
  });
  if (!res.ok) throw new Error(`getTokenAccountsByOwner failed: ${res.status}`);
  const body = await res.json() as { result?: { value: any[] } };
  const accs = body.result?.value ?? [];
  return accs.reduce<bigint>(
    (acc, a) => acc + BigInt(a.account.data.parsed.info.tokenAmount.amount),
    0n,
  );
}
