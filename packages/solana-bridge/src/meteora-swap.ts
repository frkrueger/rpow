import { Connection, Keypair, PublicKey, Commitment } from '@solana/web3.js';
import { CpAmm, getTokenProgram } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import bs58 from 'bs58';

/**
 * Direct swap against a Meteora DAMM v2 (cp-amm) pool.
 *
 * Used as the fallback for the unwrap fee swap when Jupiter refuses to route
 * SRPOW (it returns TOKEN_NOT_TRADABLE for low-liquidity tokens). The only
 * SRPOW pool is SRPOW/USDC on Meteora, so this leg lands USDC; the caller
 * then swaps USDC -> SOL via Jupiter, which routes USDC fine.
 */

export type MeteoraSwapStatus =
  | { status: 'confirmed'; signature: string; outputMint: string; out_amount: bigint }
  | { status: 'failed'; signature: string | null; failureReason: string };

/** The subset of the cp-amm SDK we use; injectable for tests. */
export interface CpAmmLike {
  fetchPoolState(pool: PublicKey): Promise<any>;
  getQuote(params: any): { swapOutAmount: BN; minSwapOutAmount: BN };
  swap(params: any): Promise<import('@solana/web3.js').Transaction>;
}

export interface MeteoraClientOpts {
  connection: Connection;
  bridge: Keypair;
  pool: PublicKey;
  commitment: Commitment;
  timeoutMs: number;
  cpAmm?: CpAmmLike;
}

export interface MeteoraSwapArgs {
  inputMint: string;
  amountBaseUnits: bigint;
  maxSlippageBps: number;
  onSignaturePrepared: (signature: string) => Promise<void>;
}

export class MeteoraClient {
  private cpAmm: CpAmmLike;

  constructor(private opts: MeteoraClientOpts) {
    this.cpAmm = opts.cpAmm ?? new CpAmm(opts.connection);
  }

  async swap(args: MeteoraSwapArgs): Promise<MeteoraSwapStatus> {
    let signature: string | null = null;
    try {
      const inputMint = new PublicKey(args.inputMint);
      const ps = await this.cpAmm.fetchPoolState(this.opts.pool);
      const tokenAMint: PublicKey = ps.tokenAMint;
      const tokenBMint: PublicKey = ps.tokenBMint;
      let outputMint: PublicKey;
      if (tokenAMint.equals(inputMint)) outputMint = tokenBMint;
      else if (tokenBMint.equals(inputMint)) outputMint = tokenAMint;
      else return { status: 'failed', signature: null, failureReason: `input mint ${args.inputMint} not in pool ${this.opts.pool.toBase58()}` };

      const [currentSlot, currentTime] = [await this.opts.connection.getSlot(), Math.floor(Date.now() / 1000)];
      const amountIn = new BN(args.amountBaseUnits.toString());
      // `slippage` is in bps (verified empirically: 10 -> 0.1%).
      const quote = this.cpAmm.getQuote({
        inAmount: amountIn, inputTokenMint: inputMint, slippage: args.maxSlippageBps,
        poolState: ps, currentTime, currentSlot,
      });

      const tx = await this.cpAmm.swap({
        payer: this.opts.bridge.publicKey,
        pool: this.opts.pool,
        inputTokenMint: inputMint,
        outputTokenMint: outputMint,
        amountIn,
        minimumAmountOut: quote.minSwapOutAmount,
        tokenAMint, tokenBMint,
        tokenAVault: ps.tokenAVault, tokenBVault: ps.tokenBVault,
        tokenAProgram: getTokenProgram(ps.tokenAFlag),
        tokenBProgram: getTokenProgram(ps.tokenBFlag),
        referralTokenAccount: null,
      });

      const { blockhash, lastValidBlockHeight } =
        await this.opts.connection.getLatestBlockhash(this.opts.commitment);
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.opts.bridge.publicKey;
      tx.sign(this.opts.bridge);

      signature = bs58.encode(tx.signature!);
      await args.onSignaturePrepared(signature);

      await this.opts.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false, preflightCommitment: this.opts.commitment,
      });

      let timeoutHandle: NodeJS.Timeout | undefined;
      try {
        const confirmPromise = this.opts.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight }, this.opts.commitment,
        );
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`meteora swap confirmation timeout after ${this.opts.timeoutMs}ms`)),
            this.opts.timeoutMs,
          );
        });
        const c = await Promise.race([confirmPromise, timeoutPromise]);
        if (c.value.err) {
          return { status: 'failed', signature, failureReason: `confirmation err: ${JSON.stringify(c.value.err)}` };
        }
        return {
          status: 'confirmed', signature, outputMint: outputMint.toBase58(),
          out_amount: BigInt(quote.swapOutAmount.toString()),
        };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } catch (e: any) {
      return { status: 'failed', signature, failureReason: e?.message ?? String(e) };
    }
  }
}
