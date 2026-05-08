import { useEffect, useState } from 'react';
import bs58 from 'bs58';

declare global {
  interface Window {
    solana?: {
      isPhantom?: boolean;
      publicKey?: { toString(): string };
      connect(): Promise<{ publicKey: { toString(): string } }>;
      signMessage(m: Uint8Array, encoding: 'utf8'): Promise<{ signature: Uint8Array }>;
      disconnect(): Promise<void>;
    };
  }
}

export function usePhantom() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [installed, setInstalled] = useState<boolean>(false);

  useEffect(() => {
    setInstalled(!!window.solana?.isPhantom);
    setWallet(window.solana?.publicKey?.toString() ?? null);
  }, []);

  async function connect(): Promise<string> {
    if (!window.solana?.isPhantom) throw new Error('Phantom not installed');
    const r = await window.solana.connect();
    const pk = r.publicKey.toString();
    setWallet(pk);
    return pk;
  }

  async function signMessage(message: string): Promise<string> {
    if (!window.solana) throw new Error('Phantom not connected');
    const { signature } = await window.solana.signMessage(new TextEncoder().encode(message), 'utf8');
    return bs58.encode(signature);
  }

  return { wallet, installed, connect, signMessage };
}
