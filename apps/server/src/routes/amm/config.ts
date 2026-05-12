import type { FastifyInstance } from 'fastify';

export async function configRoutes(app: FastifyInstance) {
  app.get('/amm/config', async (_req, reply) => {
    reply
      .header('cache-control', 'public, max-age=300')
      .code(200)
      .send({
        usdc_mint: app.config.usdcMintAddress,
        amm_wallet_pubkey: app.config.ammUsdcWalletPubkey,
        amm_wallet_ata: app.config.ammUsdcWalletAta,
      });
  });
}
