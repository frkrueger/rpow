import nacl from 'tweetnacl';
import bs58 from 'bs58';

/**
 * Verify an ed25519 signature produced by Phantom's `signMessage` API.
 *
 * Returns `false` for any failure mode without distinguishing them:
 *   - signature/wallet address not valid base58
 *   - signature is not 64 bytes (after decode)
 *   - wallet pubkey is not 32 bytes (after decode)
 *   - signature is well-formed but does not verify against (message, pubkey)
 *
 * Callers that need to surface the cause (e.g. for ops logging or 400-vs-401
 * distinction) should validate the inputs first and rely on this only for the
 * cryptographic check.
 */
export function verifyPhantomSignature(
  message: string,
  signatureBase58: string,
  walletBase58: string,
): boolean {
  try {
    const sig = bs58.decode(signatureBase58);
    const pub = bs58.decode(walletBase58);
    if (sig.length !== 64 || pub.length !== 32) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pub);
  } catch {
    return false;
  }
}
