// Server-side proxy for Solana JSON-RPC calls. Keeps the Helius API key
// out of the client bundle. The web app sets VITE_SOLANA_RPC_URL to
// `https://api.rpow2.com/solana-rpc`; calls are forwarded as-is to the
// upstream env.SOLANA_RPC_URL.

import type { FastifyInstance } from 'fastify';

export async function solanaRpcRoutes(app: FastifyInstance) {
  app.post('/solana-rpc', async (req, reply) => {
    const upstream = process.env.SOLANA_RPC_URL;
    if (!upstream) {
      return reply.code(503).send({ error: 'NO_RPC', message: 'SOLANA_RPC_URL not configured' });
    }
    try {
      const r = await fetch(upstream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body ?? {}),
      });
      const body = await r.text();
      reply.code(r.status).type('application/json').send(body);
    } catch (e: any) {
      reply.code(502).send({ error: 'UPSTREAM_FAILED', message: e?.message ?? 'fetch failed' });
    }
  });
}
