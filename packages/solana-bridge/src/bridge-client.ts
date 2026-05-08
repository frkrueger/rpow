import {
  Connection, Keypair, PublicKey, Commitment, Transaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';

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
}

type Queued =
  | { signature: string; error?: undefined }
  | { signature?: string; error: string };

export class FakeBridgeClient implements BridgeClient {
  calls: MintToArgs[] = [];
  private queue: Queued[] = [];
  private statuses = new Map<string, SignatureStatus>();

  queueResult(r: Queued): void { this.queue.push(r); }
  setSignatureStatus(sig: string, status: SignatureStatus): void {
    this.statuses.set(sig, status);
  }

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
}

export interface SolanaBridgeClientOptions {
  connection: Connection;
  bridge: Keypair;
  mint: PublicKey;
  commitment: Commitment;          // 'confirmed' | 'finalized'
  baseUnitsPerToken: bigint;       // 10n ** 9n for SRPOW
  timeoutMs: number;
}

export class SolanaBridgeClient implements BridgeClient {
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
}
