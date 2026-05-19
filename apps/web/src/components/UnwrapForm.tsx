import { useMemo, useState } from 'react';
import type { SrpowConfig } from '../hooks/useSrpowConfig.js';

const BASE_UNITS_PER_RPOW = 1_000_000_000n;

interface Props {
  srpowBalanceBaseUnits: bigint;
  config: SrpowConfig;
  /** Phantom wallet adapter (or compatible). null = not connected. */
  walletAdapter: any | null;
  onUnwrapped?: () => void;
}

function rpowFromBaseUnits(b: bigint): string {
  return (Number(b) / Number(BASE_UNITS_PER_RPOW)).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function UnwrapForm({ srpowBalanceBaseUnits, config, walletAdapter, onUnwrapped }: Props) {
  const [inputRpow, setInputRpow] = useState('');
  const [status, setStatus] = useState<'idle' | 'signing' | 'verifying' | 'swapping' | 'burning' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const inputBaseUnits = useMemo<bigint | null>(() => {
    if (!inputRpow) return null;
    try { return BigInt(Math.floor(Number(inputRpow) * Number(BASE_UNITS_PER_RPOW))); }
    catch { return null; }
  }, [inputRpow]);

  const min = BigInt(config.min_unwrap_base_units);
  const max = BigInt(config.max_unwrap_base_units);
  const feeBaseUnits = inputBaseUnits == null ? null
    : (inputBaseUnits * BigInt(config.fee_bps)) / 10000n;
  const creditBaseUnits = inputBaseUnits == null || feeBaseUnits == null ? null
    : inputBaseUnits - feeBaseUnits;

  const tooLow = inputBaseUnits != null && inputBaseUnits < min;
  const tooHigh = inputBaseUnits != null && inputBaseUnits > max;
  const overBalance = inputBaseUnits != null && inputBaseUnits > srpowBalanceBaseUnits;
  const disabled = !inputBaseUnits || tooLow || tooHigh || overBalance || !walletAdapter || status !== 'idle';

  async function handleUnwrap() {
    if (!inputBaseUnits || !walletAdapter) return;
    setStatus('signing'); setError(null);
    try {
      const signature = await sendSrpowTransferToBridge(walletAdapter, config, inputBaseUnits);
      setStatus('verifying');
      const res = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? ''}/srpow/unwrap`, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          signature, amount_base_units: inputBaseUnits.toString(),
          idempotency_key: crypto.randomUUID(),
        }),
      });
      const body = await res.json();
      if (res.status === 200) {
        setStatus('done');
        onUnwrapped?.();
      } else if (res.status === 202) {
        await pollEvent(body.event_id, setStatus);
        onUnwrapped?.();
      } else {
        setStatus('error'); setError(body.error ?? `HTTP ${res.status}`);
      }
    } catch (e: any) {
      setStatus('error'); setError(e?.message ?? String(e));
    }
  }

  return (
    <div className="panel">
      <h3>Unwrap SRPOW → RPOW</h3>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
        SRPOW balance: <strong>{rpowFromBaseUnits(srpowBalanceBaseUnits)}</strong> SRPOW
      </div>
      <label htmlFor="unwrap-amount">Amount (SRPOW)</label>
      <input
        id="unwrap-amount"
        value={inputRpow}
        onChange={(e) => setInputRpow(e.target.value)}
        placeholder="e.g. 100"
      />
      {creditBaseUnits != null && feeBaseUnits != null && inputBaseUnits != null && (
        <div style={{ fontSize: 12, margin: '8px 0' }}>
          <strong>{`Receive ${rpowFromBaseUnits(creditBaseUnits)} RPOW`}</strong>
          <br />
          <span>{`${rpowFromBaseUnits(feeBaseUnits)} SRPOW fee swapped to SOL (${config.fee_bps / 100}%)`}</span>
        </div>
      )}
      {tooLow && <div style={{ color: '#f88' }}>Below minimum ({rpowFromBaseUnits(min)} RPOW)</div>}
      {tooHigh && <div style={{ color: '#f88' }}>Above maximum</div>}
      {overBalance && <div style={{ color: '#f88' }}>Exceeds your SRPOW balance</div>}
      <button onClick={handleUnwrap} disabled={disabled}>
        {status === 'idle' ? 'Unwrap' : status}
      </button>
      {error && <div style={{ color: '#f88', marginTop: 8 }}>Error: {error}</div>}
    </div>
  );
}

// Build & send the inbound SPL transfer via Phantom. Mirrors UsdcDeposit pattern.
async function sendSrpowTransferToBridge(
  walletAdapter: any, config: SrpowConfig, amountBaseUnits: bigint,
): Promise<string> {
  const { Connection, PublicKey, Transaction } = await import('@solana/web3.js');
  const { getAssociatedTokenAddressSync, createTransferCheckedInstruction } = await import('@solana/spl-token');

  const rpcUrl = import.meta.env.VITE_SOLANA_RPC_URL as string;
  const conn = new Connection(rpcUrl, 'finalized');

  const owner = walletAdapter.publicKey as InstanceType<typeof PublicKey>;
  if (!owner) throw new Error('wallet not connected');
  const mint = new PublicKey(config.srpow_mint_address);
  const bridge = new PublicKey(config.bridge_wallet_pubkey);

  const fromAta = getAssociatedTokenAddressSync(mint, owner);
  const toAta = getAssociatedTokenAddressSync(mint, bridge);

  const tx = new Transaction();
  tx.add(createTransferCheckedInstruction(
    fromAta, mint, toAta, owner, amountBaseUnits, 9,
  ));

  const { blockhash } = await conn.getLatestBlockhash('finalized');
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;

  const sig: string = await walletAdapter.sendTransaction(tx, conn);
  await conn.confirmTransaction(sig, 'finalized');
  return sig;
}

async function pollEvent(eventId: string, setStatus: (s: any) => void): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    await new Promise(r => setTimeout(r, 1500));
    const res = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? ''}/srpow/events/${eventId}`, { credentials: 'include' });
    if (!res.ok) continue;
    const ev = await res.json();
    if (ev.swap_signature && !ev.burn_signature) setStatus('burning');
    if (ev.status === 'CONFIRMED') { setStatus('done'); return; }
    if (ev.status === 'REFUNDED' || ev.status === 'FAILED') {
      throw new Error(ev.failure_reason ?? ev.status);
    }
  }
  throw new Error('timed out polling unwrap event');
}
