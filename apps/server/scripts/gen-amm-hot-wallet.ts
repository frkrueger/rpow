import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// One-off generator for the AMM hot wallet — the Solana keypair the server
// uses to (a) receive incoming USDC deposits (slice 5) and (b) sign outbound
// USDC withdrawals (slice 6).
//
// Output is two env-style lines suitable to append to /etc/rpow/.env on the
// VPS. The secret key MUST be treated as a production credential:
//
//   1. Redirect this command's stdout to a file: `... --init-keys > wallet.env`
//   2. Move wallet.env to the VPS at /etc/rpow/amm-wallet.env, chmod 600,
//      and source it from the systemd unit's EnvironmentFile=.
//   3. Delete the local copy.
//   4. Fund AMM_USDC_WALLET_PUBKEY with ~0.05 SOL (covers ATA rent + many fees).
//   5. Create the USDC associated token account for the wallet:
//        `spl-token create-account EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
//                                  --owner <pubkey> --fee-payer ~/.config/solana/id.json`
//   6. Smoke-test by sending 0.01 USDC to the wallet's ATA from another wallet.
//
// Never commit the secret. The repo's .gitignore covers `*-hot-wallet*` and
// `*amm-wallet*.env` defensively but the right answer is to never write the
// file inside the repo tree.

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--init-keys')) {
    console.error('usage: tsx gen-amm-hot-wallet.ts --init-keys > /path/to/wallet.env');
    console.error('refusing to run without --init-keys (defensive).');
    process.exit(1);
  }
  const kp = Keypair.generate();
  console.log(`AMM_USDC_WALLET_PUBKEY=${kp.publicKey.toBase58()}`);
  console.log(`AMM_USDC_WALLET_KEYPAIR_BASE58=${bs58.encode(kp.secretKey)}`);
  console.log(`# USDC mint (mainnet): EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`);
  console.log(`# Fund the pubkey with ~0.05 SOL and create the USDC ATA before going live.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
