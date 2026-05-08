import {
  Connection, Keypair, PublicKey, Commitment,
} from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount, mintTo as splMintTo,
} from '@solana/spl-token';

export interface MintToArgs { recipientWallet: string; amount: number }
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

export interface BridgeClient {
  mintTo(args: MintToArgs): Promise<MintToResult>;
  getSignatureStatus(signature: string): Promise<SignatureStatus>;
}

type Queued =
  | { signature: string; error?: undefined }
  | { signature?: undefined; error: string };

export class FakeBridgeClient implements BridgeClient {
  calls: MintToArgs[] = [];
  private queue: Queued[] = [];
  private statuses = new Map<string, SignatureStatus>();

  queueResult(r: Queued): void { this.queue.push(r); }
  setSignatureStatus(sig: string, status: SignatureStatus): void {
    this.statuses.set(sig, status);
  }

  async mintTo(args: MintToArgs): Promise<MintToResult> {
    this.calls.push(args);
    const next = this.queue.shift();
    if (!next) throw new Error('FakeBridgeClient: no result queued');
    if (next.error !== undefined) {
      return { status: 'failed', signature: null, failureReason: next.error };
    }
    return { status: 'confirmed', signature: next.signature };
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

  async mintTo({ recipientWallet, amount }: MintToArgs): Promise<MintToResult> {
    // Validate recipient outside the try so an invalid pubkey throws (programmer
    // error) rather than being silently absorbed into a refund (RPC failure).
    const recipient = new PublicKey(recipientWallet);
    try {
      const ata = await getOrCreateAssociatedTokenAccount(
        this.opts.connection, this.opts.bridge, this.opts.mint, recipient,
        false, this.opts.commitment,
      );
      const baseUnits = BigInt(amount) * this.opts.baseUnitsPerToken;
      const sig = await splMintTo(
        this.opts.connection, this.opts.bridge, this.opts.mint, ata.address,
        this.opts.bridge, baseUnits, [], { commitment: this.opts.commitment },
      );
      return { status: 'confirmed', signature: sig };
    } catch (e: any) {
      return { status: 'failed', signature: null, failureReason: e?.message ?? String(e) };
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
