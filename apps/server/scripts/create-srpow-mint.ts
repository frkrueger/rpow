import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createMint } from '@solana/spl-token';
import bs58 from 'bs58';
import { SRPOW_DECIMALS } from '@rpow/solana-bridge';

const MIN_BALANCE_LAMPORTS = 0.005 * LAMPORTS_PER_SOL;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--init-keys')) {
    const kp = Keypair.generate();
    console.log(`BRIDGE_PUBKEY=${kp.publicKey.toBase58()}`);
    console.log(`BRIDGE_KEYPAIR_BASE58=${bs58.encode(kp.secretKey)}`);
    console.log(`# Send >=0.05 SOL to BRIDGE_PUBKEY before running default mode.`);
    return;
  }

  if (process.env.SRPOW_MINT_ADDRESS) {
    throw new Error('refusing: SRPOW_MINT_ADDRESS already set in env (mint already created)');
  }
  const rpc = process.env.SOLANA_RPC_URL;
  const sk = process.env.BRIDGE_KEYPAIR_BASE58;
  if (!rpc) throw new Error('SOLANA_RPC_URL required');
  if (!sk) throw new Error('BRIDGE_KEYPAIR_BASE58 required (run with --init-keys first)');

  const conn = new Connection(rpc, 'confirmed');
  const bridge = Keypair.fromSecretKey(bs58.decode(sk));
  const balance = await conn.getBalance(bridge.publicKey);
  if (balance < MIN_BALANCE_LAMPORTS) {
    throw new Error(`bridge balance ${balance / LAMPORTS_PER_SOL} SOL < required 0.005 SOL`);
  }

  const mint = await createMint(
    conn,
    bridge,                        // payer
    bridge.publicKey,              // mint authority
    null,                          // freeze authority RENOUNCED
    SRPOW_DECIMALS,
  );
  console.log(`SRPOW_MINT_ADDRESS=${mint.toBase58()}`);
  console.log(`# Verify on https://solscan.io/token/${mint.toBase58()} : decimals=9, freeze authority null, mint authority=${bridge.publicKey.toBase58()}, supply=0`);
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
