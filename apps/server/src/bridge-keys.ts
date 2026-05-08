import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export function loadBridgeKeypair(base58: string): Keypair {
  const secret = bs58.decode(base58);
  if (secret.length !== 64) {
    throw new Error(`bridge-keys: expected 64-byte secret, got ${secret.length}`);
  }
  return Keypair.fromSecretKey(secret);
}
