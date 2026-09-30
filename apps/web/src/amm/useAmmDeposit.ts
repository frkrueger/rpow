import { useCallback, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import type { AmmConfig } from '../api/amm';

export type DepositPhase = 'idle' | 'signing' | 'broadcasting' | 'confirming' | 'awaiting_credit' | 'credited' | 'error';

export function useAmmDeposit(config: AmmConfig | null) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const [phase, setPhase] = useState<DepositPhase>('idle');
  const [sig, setSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const deposit = useCallback(async (amountBaseUnits: bigint) => {
    if (!config) throw new Error('CONFIG_MISSING');
    if (!publicKey || !signTransaction) throw new Error('WALLET_NOT_CONNECTED');
    setPhase('signing'); setError(null); setSig(null);

    const usdcMint = new PublicKey(config.usdc_mint);
    const ammAta   = new PublicKey(config.amm_wallet_ata);
    const userAta  = await getAssociatedTokenAddress(usdcMint, publicKey);

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const ix = createTransferCheckedInstruction(
      userAta, usdcMint, ammAta, publicKey, amountBaseUnits, 6,
    );
    const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash }).add(ix);

    let signed;
    try { signed = await signTransaction(tx); }
    catch (e: any) { setPhase('error'); setError(e.message ?? 'sign_rejected'); throw e; }

    setPhase('broadcasting');
    let signature: string;
    try {
      signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    } catch (e: any) { setPhase('error'); setError(e.message ?? 'broadcast_failed'); throw e; }
    setSig(signature);

    setPhase('confirming');
    try {
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    } catch (e: any) { setPhase('error'); setError(e.message ?? 'confirm_failed'); throw e; }

    setPhase('awaiting_credit');
    return signature;
  }, [config, publicKey, signTransaction, connection]);

  return { deposit, phase, sig, error, setPhase };
}
