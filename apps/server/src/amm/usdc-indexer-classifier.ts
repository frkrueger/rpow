/**
 * Pure classifier: given a parsed Solana tx + our AMM USDC ATA + the USDC mint,
 * return the list of SPL transfers that credit our ATA.
 *
 * Returns sender wallet pubkey (parsed.info.authority — the signer that
 * authorized the transfer, not the source token-account address).
 *
 * Walks both top-level instructions AND inner instructions (CPI).
 */

export interface UsdcTransfer {
  amount: bigint;
  authority: string;   // sender wallet pubkey (base58)
}

const TOKEN_PROGRAMS = new Set(['spl-token', 'spl-token-2022']);

function instructionMatches(ix: any, ammAta: string, usdcMint: string): UsdcTransfer | null {
  if (!ix || typeof ix !== 'object') return null;
  if (!TOKEN_PROGRAMS.has(ix.program)) return null;
  const parsed = ix.parsed;
  if (!parsed) return null;
  if (parsed.type !== 'transfer' && parsed.type !== 'transferChecked') return null;
  const info = parsed.info;
  if (!info || info.destination !== ammAta) return null;
  // For transferChecked, info.mint is present. For plain transfer it isn't;
  // we trust the destination-ATA filter (each ATA is mint-specific).
  if (parsed.type === 'transferChecked' && info.mint !== usdcMint) return null;

  const amountStr = parsed.type === 'transferChecked'
    ? (info.tokenAmount?.amount ?? info.amount)
    : info.amount;
  if (amountStr == null) return null;
  let amount: bigint;
  try { amount = BigInt(amountStr); } catch { return null; }
  if (amount <= 0n) return null;

  const authority = info.authority;
  if (typeof authority !== 'string' || !authority) return null;

  return { amount, authority };
}

export function extractUsdcTransfersTo(
  tx: any,
  ammAta: string,
  usdcMint: string,
): UsdcTransfer[] {
  const out: UsdcTransfer[] = [];
  const top = tx?.transaction?.message?.instructions ?? [];
  for (const ix of top) {
    const m = instructionMatches(ix, ammAta, usdcMint);
    if (m) out.push(m);
  }
  const innerGroups = tx?.meta?.innerInstructions ?? [];
  for (const g of innerGroups) {
    for (const ix of g.instructions ?? []) {
      const m = instructionMatches(ix, ammAta, usdcMint);
      if (m) out.push(m);
    }
  }
  return out;
}
