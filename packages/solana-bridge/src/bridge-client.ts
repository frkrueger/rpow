import {
  Connection, Keypair, PublicKey, Commitment, Transaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createBurnInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { JupiterClient } from './jupiter-swap.js';

export interface MintToArgs { recipientWallet: string; amountBaseUnits: bigint }
export type MintToResult =
  | { status: 'confirmed'; signature: string }
  | { status: 'failed'; signature: string | null; failureReason: string };

/**
 * Status of a Solana transaction signature looked up after submission.
 *
 *   - `confirmed`  — finalized at the configured commitment level or higher.
 *                    Safe to mark the corresponding wrap event CONFIRMED.
 *   - `failed`     — chain returned a definitive error (`err` field set).
 *                    Safe to refund.
 *   - `not_found`  — the signature is not known to the cluster's recent
 *                    transaction history. Either it was never submitted, or
 *                    submission landed in a fork that was abandoned. Safe to
 *                    refund (after the wrap timeout has elapsed).
 *   - `pending`    — known to the cluster but below the configured commitment
 *                    level (e.g. `processed` while we want `confirmed`). Caller
 *                    should NOT refund — the transaction may still confirm.
 *                    Caller should retry the lookup later.
 *
 * The `not_found` vs. `pending` distinction is load-bearing for crash recovery:
 * a server that crashes immediately after a `mintTo` submit could see the tx
 * in either state on reboot. Refunding a `pending` tx would let the SRPOW mint
 * land on Solana while the rpow side reverts to VALID, breaking the 1:1
 * invariant.
 */
export type SignatureStatus = 'confirmed' | 'failed' | 'not_found' | 'pending';

// ---- Inbound transfer verification (unwrap step 1) -----------------------

export interface VerifyInboundTransferArgs {
  signature: string;
  expectedFrom: string;        // user's bound wallet (base58)
  expectedTo: string;          // bridge wallet (base58)
  expectedAmount: bigint;      // SRPOW base units
  mint: string;                // SRPOW mint pubkey (base58)
}

export type VerifyInboundTransferResult =
  | { status: 'confirmed' }
  | { status: 'pending' }
  | { status: 'not_found' }
  | { status: 'failed'; reason: string }
  | { status: 'mismatch'; reason: 'wrong_from' | 'wrong_to' | 'wrong_amount' | 'wrong_mint' };

// ---- SRPOW → SOL Jupiter swap (unwrap step 2) ----------------------------

export type SwapSrpowForSolResult =
  | { status: 'confirmed'; signature: string; sol_received_lamports: bigint }
  | { status: 'slippage_exceeded'; quoted_slippage_bps: number }
  | { status: 'failed'; signature: string | null; failureReason: string };

// ---- SRPOW burn (unwrap step 3) ------------------------------------------

export type BurnSrpowResult =
  | { status: 'confirmed'; signature: string }
  | { status: 'failed'; signature: string | null; failureReason: string };

/**
 * Callback invoked by `mintTo` AFTER the tx has been signed locally (so the
 * signature is final) but BEFORE the raw tx is submitted to the cluster. The
 * caller is expected to durably persist `signature` here. If the callback
 * throws or rejects, the bridge client MUST NOT submit the tx — no SOL is
 * spent, no on-chain effect — and `mintTo` returns
 * `{ status: 'failed', signature: null, failureReason: ... }`.
 *
 * On a server crash between this callback resolving and final confirmation,
 * the reconcile worker can use the persisted signature with
 * `getSignatureStatus` to determine the correct outcome.
 */
export type OnSignaturePrepared = (signature: string) => Promise<void>;

export interface BridgeClient {
  /**
   * Build, sign, and submit a mint tx. Calls `onSignaturePrepared(sig)` after
   * the tx is signed but before it is submitted to the cluster, so the caller
   * can persist the signature for crash-recovery. After the callback resolves,
   * the tx is submitted and the bridge client awaits commitment with the
   * configured timeout, returning the final status.
   */
  mintTo(args: MintToArgs, onSignaturePrepared: OnSignaturePrepared): Promise<MintToResult>;
  getSignatureStatus(signature: string): Promise<SignatureStatus>;
  verifyInboundTransfer(args: VerifyInboundTransferArgs): Promise<VerifyInboundTransferResult>;
  swapSrpowForSol(
    amountBaseUnits: bigint,
    maxSlippageBps: number,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<SwapSrpowForSolResult>;
  burnSrpow(
    amountBaseUnits: bigint,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<BurnSrpowResult>;
  transferSrpowFromBridge(
    recipientWallet: string,
    amountBaseUnits: bigint,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<MintToResult>;
}

type Queued =
  | { signature: string; error?: undefined }
  | { signature?: string; error: string };

export class FakeBridgeClient implements BridgeClient {
  calls: MintToArgs[] = [];
  private queue: Queued[] = [];
  private statuses = new Map<string, SignatureStatus>();
  private inboundVerifyQueue: VerifyInboundTransferResult[] = [];
  private swapQueue: SwapSrpowForSolResult[] = [];
  private burnQueue: BurnSrpowResult[] = [];
  burnCalls: { amountBaseUnits: bigint }[] = [];
  swapCalls: { amountBaseUnits: bigint; maxSlippageBps: number }[] = [];
  transferFromBridgeCalls: { recipientWallet: string; amountBaseUnits: bigint }[] = [];

  queueResult(r: Queued): void { this.queue.push(r); }
  setSignatureStatus(sig: string, status: SignatureStatus): void {
    this.statuses.set(sig, status);
  }
  queueInboundVerify(r: VerifyInboundTransferResult): void { this.inboundVerifyQueue.push(r); }
  queueSwapResult(r: SwapSrpowForSolResult): void { this.swapQueue.push(r); }
  queueBurnResult(r: BurnSrpowResult): void { this.burnQueue.push(r); }

  async mintTo(
    args: MintToArgs,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<MintToResult> {
    this.calls.push(args);
    const next = this.queue.shift();
    if (!next) throw new Error('FakeBridgeClient: no result queued');

    // Synthesize a deterministic-ish signature so the caller can persist it
    // before "confirmation" returns. If the queued result has its own
    // signature, use that; otherwise generate a placeholder.
    const sig = next.signature ?? `fake_sig_${this.calls.length}`;

    // Mirror the SolanaBridgeClient contract: if the pre-submit storage hook
    // throws, we did NOT submit the tx, so return a structured failure with
    // no signature. The caller (route handler) sees this as a normal bridge
    // failure and falls into the refund path.
    try {
      await onSignaturePrepared(sig);
    } catch (e: any) {
      return {
        status: 'failed',
        signature: null,
        failureReason: `pre-submit storage failure: ${e?.message ?? String(e)}`,
      };
    }

    if (next.error !== undefined) {
      return { status: 'failed', signature: sig, failureReason: next.error };
    }
    return { status: 'confirmed', signature: sig };
  }

  async getSignatureStatus(signature: string): Promise<SignatureStatus> {
    return this.statuses.get(signature) ?? 'not_found';
  }

  async verifyInboundTransfer(_args: VerifyInboundTransferArgs): Promise<VerifyInboundTransferResult> {
    const next = this.inboundVerifyQueue.shift();
    if (!next) throw new Error('FakeBridgeClient: no inbound verify queued');
    return next;
  }

  async swapSrpowForSol(
    amountBaseUnits: bigint,
    maxSlippageBps: number,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<SwapSrpowForSolResult> {
    this.swapCalls.push({ amountBaseUnits, maxSlippageBps });
    const next = this.swapQueue.shift();
    if (!next) throw new Error('FakeBridgeClient: no swap result queued');
    // Mirror mintTo: call onSignaturePrepared whenever a signature exists,
    // so the persist-before-submit contract holds for both success and failure.
    const sig = next.status === 'confirmed'
      ? next.signature
      : (next.status === 'failed' ? next.signature : null);
    if (sig !== null) {
      try { await onSignaturePrepared(sig); }
      catch (e: any) {
        return { status: 'failed', signature: null, failureReason: `pre-submit storage failure: ${e?.message ?? String(e)}` };
      }
    }
    return next;
  }

  async burnSrpow(
    amountBaseUnits: bigint,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<BurnSrpowResult> {
    this.burnCalls.push({ amountBaseUnits });
    const next = this.burnQueue.shift();
    if (!next) throw new Error('FakeBridgeClient: no burn result queued');
    const sig = next.status === 'confirmed'
      ? next.signature
      : (next.status === 'failed' ? next.signature : null);
    if (sig !== null) {
      try { await onSignaturePrepared(sig); }
      catch (e: any) {
        return { status: 'failed', signature: null, failureReason: `pre-submit storage failure: ${e?.message ?? String(e)}` };
      }
    }
    return next;
  }

  async transferSrpowFromBridge(
    recipientWallet: string,
    amountBaseUnits: bigint,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<MintToResult> {
    this.transferFromBridgeCalls.push({ recipientWallet, amountBaseUnits });
    const result = await this.mintTo(
      { recipientWallet, amountBaseUnits },
      onSignaturePrepared,
    );
    // mintTo appended to this.calls; remove it so `calls` remains a pure
    // mintTo-only record (matters for tests that assert on calls.length).
    this.calls.pop();
    return result;
  }
}

export interface SolanaBridgeClientOptions {
  connection: Connection;
  bridge: Keypair;
  mint: PublicKey;
  commitment: Commitment;          // 'confirmed' | 'finalized'
  baseUnitsPerToken: bigint;       // 10n ** 9n for SRPOW
  timeoutMs: number;
  jupiterApiBase: string;
}

export class SolanaBridgeClient implements BridgeClient {
  private jupiter: JupiterClient | null = null;

  constructor(private opts: SolanaBridgeClientOptions) {}

  async mintTo(
    { recipientWallet, amountBaseUnits }: MintToArgs,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<MintToResult> {
    // Validate recipient outside the try so an invalid pubkey throws (programmer
    // error) rather than being silently absorbed into a refund (RPC failure).
    const recipient = new PublicKey(recipientWallet);
    let signature: string | null = null;
    try {
      const ata = getAssociatedTokenAddressSync(this.opts.mint, recipient);
      const ataInfo = await this.opts.connection.getAccountInfo(ata, this.opts.commitment);

      const tx = new Transaction();
      if (!ataInfo) {
        tx.add(createAssociatedTokenAccountInstruction(
          this.opts.bridge.publicKey, ata, recipient, this.opts.mint,
        ));
      }
      // amountBaseUnits is already in SRPOW base units (10^9 == 1 SRPOW); the
      // rpow side now also denominates in base units, so we mint 1:1 with no
      // additional scaling. opts.baseUnitsPerToken is retained for backwards
      // compatibility with the constructor call site but is no longer used.
      tx.add(createMintToInstruction(
        this.opts.mint, ata, this.opts.bridge.publicKey, amountBaseUnits,
      ));

      const { blockhash, lastValidBlockHeight } =
        await this.opts.connection.getLatestBlockhash(this.opts.commitment);
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.opts.bridge.publicKey;
      tx.sign(this.opts.bridge);

      // The tx signature is now deterministic (ed25519 over the message we
      // just built). Expose it BEFORE submit so the caller can persist it to
      // durable storage; on a crash between this point and confirmation, the
      // reconcile worker will see the persisted signature and resolve it
      // correctly via getSignatureStatus.
      signature = bs58.encode(tx.signature!);
      await onSignaturePrepared(signature);

      // Submit the raw, pre-signed tx. The wire signature is the same one we
      // just exposed via the callback.
      await this.opts.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: this.opts.commitment,
      });

      // Await commitment with explicit timeout (SRPOW_WRAP_TIMEOUT_MS). We
      // wrap confirmTransaction in Promise.race against a setTimeout so the
      // route handler is never blocked indefinitely on a stuck cluster. On
      // timeout, we return a structured failure with the signature populated;
      // the reconcile worker can later resolve the actual on-chain outcome.
      let timeoutHandle: NodeJS.Timeout | undefined;
      try {
        const confirmPromise = this.opts.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          this.opts.commitment,
        );
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`mint confirmation timeout after ${this.opts.timeoutMs}ms`)),
            this.opts.timeoutMs,
          );
        });
        const confirmation = await Promise.race([confirmPromise, timeoutPromise]);

        if (confirmation.value.err) {
          return {
            status: 'failed',
            signature,
            failureReason: `confirmation err: ${JSON.stringify(confirmation.value.err)}`,
          };
        }
        return { status: 'confirmed', signature };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } catch (e: any) {
      // Catches: ATA lookup failure, blockhash fetch failure, callback throw,
      // sendRawTransaction failure, confirmTransaction reject, and the
      // timeout sentinel. `signature` may be null (failed before sign) or
      // non-null (failed after sign — keep it so the route can persist the
      // sig for reconcile lookup).
      return {
        status: 'failed',
        signature,
        failureReason: e?.message ?? String(e),
      };
    }
  }

  async getSignatureStatus(signature: string): Promise<SignatureStatus> {
    // searchTransactionHistory=true is required for the reconcile worker to
    // see signatures older than ~150 slots (60s). Without it, an aged
    // confirmed tx returns null and we'd mistakenly refund.
    const res = await this.opts.connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    const v = res.value;
    if (!v) return 'not_found';
    if (v.err) return 'failed';
    // confirmationStatus is one of 'processed' | 'confirmed' | 'finalized'.
    // If it has reached the configured commitment (or finalized, which is
    // strictly stronger), report confirmed. Otherwise it's still in flight.
    if (v.confirmationStatus === 'finalized') return 'confirmed';
    if (v.confirmationStatus === this.opts.commitment) return 'confirmed';
    return 'pending';
  }

  async verifyInboundTransfer(args: VerifyInboundTransferArgs): Promise<VerifyInboundTransferResult> {
    // Step 1: status check distinguishes 'not_found' from 'pending' from 'failed'.
    // getTransaction() at a commitment level returns null for both "unknown" and
    // "below commitment"; we MUST distinguish so the caller doesn't auto-refund
    // an in-flight tx.
    let status: SignatureStatus;
    try {
      status = await this.getSignatureStatus(args.signature);
    } catch (e: any) {
      // Treat RPC errors here as transient — caller can retry. Map to pending
      // so the unwrap stays in PENDING state and reconcile picks it up.
      return { status: 'pending' };
    }
    if (status === 'not_found') return { status: 'not_found' };
    if (status === 'pending') return { status: 'pending' };

    // Step 2: status is 'confirmed' or 'failed' — fetch the full tx for either
    // the err detail or the balance arrays.
    const tx = await this.opts.connection.getTransaction(args.signature, {
      commitment: this.opts.commitment,
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) {
      // Defensive: status said reachable but tx fetch returned null. Treat as
      // pending so we retry rather than refund.
      return { status: 'pending' };
    }
    if (tx.meta?.err) {
      return { status: 'failed', reason: JSON.stringify(tx.meta.err) };
    }

    // Token-balance delta is the cleanest way to verify an SPL transfer in
    // either a legacy or versioned tx, and survives transfer-checked or
    // transfer-with-fee variants.
    const pre = tx.meta?.preTokenBalances ?? [];
    const post = tx.meta?.postTokenBalances ?? [];

    // Step 3: explicit mint check. If no post-balance entry is for the expected
    // mint at all, the tx is for a different mint entirely — distinguishable
    // from "right mint, wrong recipient".
    if (!post.some(b => b.mint === args.mint)) {
      return { status: 'mismatch', reason: 'wrong_mint' };
    }

    // Step 4: destination credit delta.
    const postTo = post.find(b => b.mint === args.mint && b.owner === args.expectedTo);
    if (!postTo) return { status: 'mismatch', reason: 'wrong_to' };
    const preTo = pre.find(b =>
      b.accountIndex === postTo.accountIndex && b.mint === args.mint,
    );
    const preToAmount = preTo ? BigInt(preTo.uiTokenAmount.amount) : 0n;
    const delta = BigInt(postTo.uiTokenAmount.amount) - preToAmount;
    if (delta !== args.expectedAmount) {
      return { status: 'mismatch', reason: 'wrong_amount' };
    }

    // Step 5: source debit delta — must match expected amount on the from side.
    const postFrom = post.find(b => b.mint === args.mint && b.owner === args.expectedFrom);
    if (!postFrom) return { status: 'mismatch', reason: 'wrong_from' };
    const preFrom = pre.find(b =>
      b.accountIndex === postFrom.accountIndex && b.mint === args.mint,
    );
    const preFromAmount = preFrom ? BigInt(preFrom.uiTokenAmount.amount) : 0n;
    if (preFromAmount - BigInt(postFrom.uiTokenAmount.amount) !== args.expectedAmount) {
      return { status: 'mismatch', reason: 'wrong_from' };
    }

    return { status: 'confirmed' };
  }

  async swapSrpowForSol(
    amountBaseUnits: bigint,
    maxSlippageBps: number,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<SwapSrpowForSolResult> {
    if (!this.jupiter) {
      this.jupiter = new JupiterClient({
        apiBase: this.opts.jupiterApiBase,
        connection: this.opts.connection,
        bridge: this.opts.bridge,
        commitment: this.opts.commitment,
        timeoutMs: this.opts.timeoutMs,
      });
    }
    return this.jupiter.swap({
      inputMint: this.opts.mint.toBase58(),
      outputMint: 'So11111111111111111111111111111111111111112',
      amountBaseUnits,
      maxSlippageBps,
      onSignaturePrepared,
    });
  }

  async burnSrpow(
    amountBaseUnits: bigint,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<BurnSrpowResult> {
    let signature: string | null = null;
    try {
      const bridgeAta = getAssociatedTokenAddressSync(this.opts.mint, this.opts.bridge.publicKey);

      const tx = new Transaction();
      tx.add(createBurnInstruction(
        bridgeAta,
        this.opts.mint,
        this.opts.bridge.publicKey,
        amountBaseUnits,
      ));

      const { blockhash, lastValidBlockHeight } =
        await this.opts.connection.getLatestBlockhash(this.opts.commitment);
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.opts.bridge.publicKey;
      tx.sign(this.opts.bridge);

      signature = bs58.encode(tx.signature!);
      await onSignaturePrepared(signature);

      await this.opts.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: this.opts.commitment,
      });

      let timeoutHandle: NodeJS.Timeout | undefined;
      try {
        const confirmPromise = this.opts.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          this.opts.commitment,
        );
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`burn confirmation timeout after ${this.opts.timeoutMs}ms`)),
            this.opts.timeoutMs,
          );
        });
        const c = await Promise.race([confirmPromise, timeoutPromise]);
        if (c.value.err) {
          return { status: 'failed', signature, failureReason: `confirmation err: ${JSON.stringify(c.value.err)}` };
        }
        return { status: 'confirmed', signature };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } catch (e: any) {
      return { status: 'failed', signature, failureReason: e?.message ?? String(e) };
    }
  }

  async transferSrpowFromBridge(
    recipientWallet: string,
    amountBaseUnits: bigint,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<MintToResult> {
    const recipient = new PublicKey(recipientWallet);
    let signature: string | null = null;
    try {
      const bridgeAta = getAssociatedTokenAddressSync(this.opts.mint, this.opts.bridge.publicKey);
      const recipientAta = getAssociatedTokenAddressSync(this.opts.mint, recipient);
      const ataInfo = await this.opts.connection.getAccountInfo(recipientAta, this.opts.commitment);

      const tx = new Transaction();
      if (!ataInfo) {
        tx.add(createAssociatedTokenAccountInstruction(
          this.opts.bridge.publicKey, recipientAta, recipient, this.opts.mint,
        ));
      }
      // transfer-checked requires the decimals; SRPOW uses 9 (baseUnitsPerToken=10^9).
      tx.add(createTransferCheckedInstruction(
        bridgeAta, this.opts.mint, recipientAta, this.opts.bridge.publicKey,
        amountBaseUnits, 9,
      ));

      const { blockhash, lastValidBlockHeight } =
        await this.opts.connection.getLatestBlockhash(this.opts.commitment);
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.opts.bridge.publicKey;
      tx.sign(this.opts.bridge);

      signature = bs58.encode(tx.signature!);
      await onSignaturePrepared(signature);

      await this.opts.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: this.opts.commitment,
      });

      let timeoutHandle: NodeJS.Timeout | undefined;
      try {
        const c = await Promise.race([
          this.opts.connection.confirmTransaction(
            { signature, blockhash, lastValidBlockHeight }, this.opts.commitment,
          ),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error(`refund confirmation timeout after ${this.opts.timeoutMs}ms`)),
              this.opts.timeoutMs,
            );
          }),
        ]);
        if (c.value.err) {
          return { status: 'failed', signature, failureReason: `confirmation err: ${JSON.stringify(c.value.err)}` };
        }
        return { status: 'confirmed', signature };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } catch (e: any) {
      return { status: 'failed', signature, failureReason: e?.message ?? String(e) };
    }
  }
}
