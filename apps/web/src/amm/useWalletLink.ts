import { useCallback, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import { postLinkChallenge, postLinkConfirm, type LinkConfirmResult } from '../api/amm';

export function useWalletLink() {
  const { publicKey, signMessage } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = useCallback(async (): Promise<LinkConfirmResult> => {
    if (!publicKey || !signMessage) throw new Error('WALLET_NOT_CONNECTED');
    setBusy(true); setError(null);
    try {
      const challenge = await postLinkChallenge();
      const messageBytes = new TextEncoder().encode(challenge.message);
      const sigBytes = await signMessage(messageBytes);
      const result = await postLinkConfirm({
        pubkey: publicKey.toBase58(),
        signature_b58: bs58.encode(sigBytes),
        nonce_envelope: challenge.nonce_envelope,
      });
      return result;
    } catch (e: any) {
      setError(e.body?.error ?? e.message ?? 'LINK_FAILED');
      throw e;
    } finally {
      setBusy(false);
    }
  }, [publicKey, signMessage]);

  return { link, busy, error };
}
