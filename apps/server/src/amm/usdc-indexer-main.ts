// apps/server/src/amm/usdc-indexer-main.ts
// Standalone Node entrypoint, NOT part of the API cluster. Launched by
// the rpow-usdc-indexer.service systemd unit on the VPS.

import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import pino from 'pino';
import { createPool } from '../db.js';
import { parseEnv } from '../env.js';
import { tick } from './usdc-indexer.js';

async function main() {
  const env = parseEnv();
  if (!env.SOLANA_RPC_URL) {
    console.error('indexer: SOLANA_RPC_URL is required');
    process.exit(1);
  }
  const log = pino({ level: process.env.INDEXER_LOG_LEVEL ?? 'info' });
  const pool = createPool(env.DATABASE_URL);
  const conn = new Connection(env.SOLANA_RPC_URL, 'finalized');

  const walletPk = new PublicKey(env.AMM_USDC_WALLET_PUBKEY);
  const mintPk   = new PublicKey(env.USDC_MINT_ADDRESS);
  const ata = env.AMM_USDC_WALLET_ATA
    ? new PublicKey(env.AMM_USDC_WALLET_ATA)
    : await getAssociatedTokenAddress(mintPk, walletPk);
  log.info({ wallet: walletPk.toBase58(), ata: ata.toBase58() }, 'indexer: boot');

  const rpc = {
    getSignaturesForAddress: async (addr: string, opts: any) => {
      const r = await conn.getSignaturesForAddress(new PublicKey(addr), opts);
      return r.map(s => ({ signature: s.signature, err: s.err, blockTime: s.blockTime ?? null }));
    },
    getParsedTransaction: async (sig: string, opts: any) => {
      return await conn.getParsedTransaction(sig, opts);
    },
  };

  const deps = {
    pool, rpc, log,
    ammAta: ata.toBase58(),
    usdcMint: mintPk.toBase58(),
    bootstrapLimit: env.INDEXER_BOOTSTRAP_LIMIT,
  };

  let running = true;
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'indexer: shutdown signal');
    running = false;
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  while (running) {
    try { await tick(deps); }
    catch (e) { log.error({ err: String(e) }, 'indexer: tick threw'); }
    if (!running) break;
    await new Promise(r => setTimeout(r, env.INDEXER_POLL_INTERVAL_MS));
  }

  await pool.end();
  log.info('indexer: stopped');
}

main().catch((e) => {
  console.error('indexer: fatal', e);
  process.exit(1);
});
