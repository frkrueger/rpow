// One-shot: mints the 1.1M satoshi allocation to a recipient pubkey using the
// bridge keypair. Run once after `create-srpow-mint.ts` and BEFORE opening the
// allowlist. After this script lands, the operator goes to streamflow.finance,
// connects the recipient wallet, and creates a 1-year linear-vesting stream.
// Streamflow handles all vesting math; this codebase does not import the
// Streamflow SDK.
//
// Idempotency: refuses to run if the SRPOW mint's on-chain supply is already
// non-zero. Safe to re-run if a previous attempt failed before submitting.
//
// Required env:
//   SOLANA_RPC_URL            — mainnet RPC URL
//   BRIDGE_KEYPAIR_BASE58     — bridge keypair (mint authority)
//   SRPOW_MINT_ADDRESS        — output of create-srpow-mint
//   SATOSHI_RECIPIENT_PUBKEY  — base58 pubkey to receive the 1.1M

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { mintTo, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import { SRPOW_BASE_UNITS_PER_RPOW } from '@rpow/solana-bridge';

const SATOSHI_AMOUNT_RPOW = 1_100_000n;

async function main() {
  const rpc = process.env.SOLANA_RPC_URL;
  const sk = process.env.BRIDGE_KEYPAIR_BASE58;
  const mint = process.env.SRPOW_MINT_ADDRESS;
  const recipient = process.env.SATOSHI_RECIPIENT_PUBKEY;
  if (!rpc) throw new Error('SOLANA_RPC_URL required');
  if (!sk) throw new Error('BRIDGE_KEYPAIR_BASE58 required');
  if (!mint) throw new Error('SRPOW_MINT_ADDRESS required');
  if (!recipient) throw new Error('SATOSHI_RECIPIENT_PUBKEY required');

  const conn = new Connection(rpc, 'confirmed');
  const bridge = Keypair.fromSecretKey(bs58.decode(sk));
  const mintPub = new PublicKey(mint);
  const recipientPub = new PublicKey(recipient);

  const before = await conn.getTokenSupply(mintPub);
  const beforeAmount = BigInt(before.value.amount);
  if (beforeAmount !== 0n) {
    throw new Error(`refusing: SRPOW mint supply is already ${beforeAmount} base units (expected 0 at first allocation). If a partial run minted but did not record, reconcile manually.`);
  }

  const recipientAta = await getOrCreateAssociatedTokenAccount(
    conn, bridge, mintPub, recipientPub, false, 'confirmed',
  );
  const baseUnits = SATOSHI_AMOUNT_RPOW * SRPOW_BASE_UNITS_PER_RPOW;
  const sig = await mintTo(
    conn, bridge, mintPub, recipientAta.address,
    bridge, baseUnits, [], { commitment: 'confirmed' },
  );

  console.log(`Minted ${SATOSHI_AMOUNT_RPOW} SRPOW (${baseUnits} base units) to ${recipient}`);
  console.log(`tx: https://solscan.io/tx/${sig}`);
  console.log(`recipient ATA: ${recipientAta.address.toBase58()}`);
  console.log(``);
  console.log(`Next: visit https://streamflow.finance, connect the recipient wallet,`);
  console.log(`and create a 1-year linear-vesting stream depositing 1,100,000 SRPOW.`);
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
