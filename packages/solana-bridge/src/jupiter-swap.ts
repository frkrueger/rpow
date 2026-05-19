import { Connection, Keypair, VersionedTransaction, Commitment } from '@solana/web3.js';
import bs58 from 'bs58';

export const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  slippageBps: number;
  /** Decimal string, e.g. '0.012' = 1.2% price impact. */
  priceImpactPct: string;
}

export interface QuoteArgs {
  apiBase: string;
  inputMint: string;
  outputMint: string;
  amountBaseUnits: bigint;
  slippageBps: number;
}

export async function fetchJupiterQuote(args: QuoteArgs): Promise<JupiterQuote> {
  const url = new URL('/v6/quote', args.apiBase);
  url.searchParams.set('inputMint', args.inputMint);
  url.searchParams.set('outputMint', args.outputMint);
  url.searchParams.set('amount', args.amountBaseUnits.toString());
  url.searchParams.set('slippageBps', String(args.slippageBps));
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`jupiter quote failed: ${res.status} ${body}`);
  }
  return (await res.json()) as JupiterQuote;
}

export type SwapStatus =
  | { status: 'confirmed'; signature: string; sol_received_lamports: bigint }
  | { status: 'slippage_exceeded'; quoted_slippage_bps: number }
  | { status: 'failed'; signature: string | null; failureReason: string };

export interface JupiterClientOpts {
  apiBase: string;
  connection: Connection;
  bridge: Keypair;
  commitment: Commitment;
  timeoutMs: number;
}

export interface SwapArgs {
  inputMint: string;
  outputMint: string;
  amountBaseUnits: bigint;
  maxSlippageBps: number;
  onSignaturePrepared: (signature: string) => Promise<void>;
}

export class JupiterClient {
  constructor(private opts: JupiterClientOpts) {}

  async swap(args: SwapArgs): Promise<SwapStatus> {
    let quote: JupiterQuote;
    try {
      quote = await fetchJupiterQuote({
        apiBase: this.opts.apiBase,
        inputMint: args.inputMint,
        outputMint: args.outputMint,
        amountBaseUnits: args.amountBaseUnits,
        slippageBps: args.maxSlippageBps,
      });
    } catch (e: any) {
      return { status: 'failed', signature: null, failureReason: e?.message ?? String(e) };
    }

    // priceImpactPct is a decimal string. 0.10 = 10% = 1000 bps.
    const impactBps = Math.round(Number(quote.priceImpactPct) * 10000);
    if (impactBps > args.maxSlippageBps) {
      return { status: 'slippage_exceeded', quoted_slippage_bps: impactBps };
    }

    let signature: string | null = null;
    try {
      const swapRes = await fetch(new URL('/v6/swap', this.opts.apiBase).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.opts.bridge.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
        }),
      });
      if (!swapRes.ok) {
        const body = await swapRes.text().catch(() => '');
        return { status: 'failed', signature: null, failureReason: `jupiter swap failed: ${swapRes.status} ${body}` };
      }
      const { swapTransaction } = await swapRes.json() as { swapTransaction: string };

      const raw = Buffer.from(swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(raw);
      tx.sign([this.opts.bridge]);
      signature = bs58.encode(tx.signatures[0]!);
      await args.onSignaturePrepared(signature);

      await this.opts.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false, preflightCommitment: this.opts.commitment,
      });

      let timeoutHandle: NodeJS.Timeout | undefined;
      try {
        const { blockhash, lastValidBlockHeight } =
          await this.opts.connection.getLatestBlockhash(this.opts.commitment);
        const confirmPromise = this.opts.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight }, this.opts.commitment,
        );
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`swap confirmation timeout after ${this.opts.timeoutMs}ms`)),
            this.opts.timeoutMs,
          );
        });
        const c = await Promise.race([confirmPromise, timeoutPromise]);
        if (c.value.err) {
          return { status: 'failed', signature, failureReason: `confirmation err: ${JSON.stringify(c.value.err)}` };
        }
        return { status: 'confirmed', signature, sol_received_lamports: BigInt(quote.outAmount) };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } catch (e: any) {
      return { status: 'failed', signature, failureReason: e?.message ?? String(e) };
    }
  }
}
