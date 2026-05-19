import type { FastifyInstance } from 'fastify';

export async function srpowUnwrapRoutes(app: FastifyInstance) {
  app.get('/srpow/config', async () => {
    return {
      bridge_wallet_pubkey: app.config.bridgeWalletPubkey ?? '',
      srpow_mint_address: app.config.srpowMintAddress ?? '',
      fee_bps: app.config.srpowUnwrapFeeBps,
      min_unwrap_base_units: app.config.srpowUnwrapMinBaseUnits.toString(),
      max_unwrap_base_units: (10n ** 18n).toString(),
      slippage_bps: app.config.srpowUnwrapSlippageBps,
    };
  });
}
