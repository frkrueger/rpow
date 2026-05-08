// One-shot: creates the Metaplex on-chain metadata account for the SRPOW SPL
// mint. After this script lands, Phantom / Solscan / Jupiter / etc. show
// SRPOW with its name, symbol, and logo image (resolved via the off-chain
// JSON pointed to by SRPOW_METADATA_URI).
//
// Run order during rollout:
//   1. create-srpow-mint           (mint exists, supply 0)
//   2. mint-satoshi-allocation     (1.1M minted to SATOSHI_RECIPIENT_PUBKEY)
//   3. (operator) upload PNG to Arweave            -> ARWEAVE_IMAGE_URL
//   4. (operator) edit srpow-token-metadata.template.json with that URL,
//                 upload the JSON to Arweave        -> ARWEAVE_METADATA_URL
//   5. set-srpow-metadata                          (this script)
//      with SRPOW_METADATA_URI=ARWEAVE_METADATA_URL
//
// `isMutable: true` is set so name/symbol/uri can be amended later (e.g.,
// host-migrating the JSON). The update authority is the bridge keypair; if
// you want to renounce update rights post-launch for credibility, run a
// follow-up tx setting updateAuthority=PublicKey.default. Out of scope for
// this script.
//
// Required env:
//   SOLANA_RPC_URL          — mainnet RPC URL
//   BRIDGE_KEYPAIR_BASE58   — bridge keypair (mint authority + payer)
//   SRPOW_MINT_ADDRESS      — output of create-srpow-mint
//   SRPOW_METADATA_URI      — Arweave URL of the off-chain metadata JSON

import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createCreateMetadataAccountV3Instruction,
  PROGRAM_ID as METADATA_PROGRAM_ID,
} from '@metaplex-foundation/mpl-token-metadata';
import bs58 from 'bs58';

const NAME = 'rpow2 SRPOW';
const SYMBOL = 'SRPOW';

async function main() {
  const rpc = process.env.SOLANA_RPC_URL;
  const sk = process.env.BRIDGE_KEYPAIR_BASE58;
  const mint = process.env.SRPOW_MINT_ADDRESS;
  const uri = process.env.SRPOW_METADATA_URI;
  if (!rpc) throw new Error('SOLANA_RPC_URL required');
  if (!sk) throw new Error('BRIDGE_KEYPAIR_BASE58 required');
  if (!mint) throw new Error('SRPOW_MINT_ADDRESS required');
  if (!uri) throw new Error('SRPOW_METADATA_URI required (Arweave URL of the off-chain JSON)');
  if (uri.length > 200) throw new Error('SRPOW_METADATA_URI > 200 chars; Metaplex caps at 200');

  const conn = new Connection(rpc, 'confirmed');
  const bridge = Keypair.fromSecretKey(bs58.decode(sk));
  const mintPub = new PublicKey(mint);

  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mintPub.toBuffer()],
    METADATA_PROGRAM_ID,
  );

  const existing = await conn.getAccountInfo(metadataPda);
  if (existing) {
    throw new Error(`refusing: metadata account already exists at ${metadataPda.toBase58()}. Use update-metadata flow instead.`);
  }

  const ix = createCreateMetadataAccountV3Instruction(
    {
      metadata: metadataPda,
      mint: mintPub,
      mintAuthority: bridge.publicKey,
      payer: bridge.publicKey,
      updateAuthority: bridge.publicKey,
    },
    {
      createMetadataAccountArgsV3: {
        data: {
          name: NAME,
          symbol: SYMBOL,
          uri,
          sellerFeeBasisPoints: 0,
          creators: null,
          collection: null,
          uses: null,
        },
        isMutable: true,
        collectionDetails: null,
      },
    },
  );

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [bridge], { commitment: 'confirmed' });

  console.log(`Metadata account: ${metadataPda.toBase58()}`);
  console.log(`tx: https://solscan.io/tx/${sig}`);
  console.log(`mint:    ${mintPub.toBase58()}`);
  console.log(`name:    ${NAME}`);
  console.log(`symbol:  ${SYMBOL}`);
  console.log(`uri:     ${uri}`);
  console.log(``);
  console.log(`Verify on Solscan: https://solscan.io/token/${mintPub.toBase58()}`);
  console.log(`Phantom/wallets will pick up the new metadata within a few minutes.`);
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
