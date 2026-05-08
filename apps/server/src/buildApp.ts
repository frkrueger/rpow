import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import type { Pool } from 'pg';
import type { Mailer } from './mailer.js';
import type { BridgeClient } from '@rpow/solana-bridge';
import { parseAllowlist } from './wrap-allowlist.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { challengeRoutes } from './routes/challenge.js';
import { mintRoutes } from './routes/mint.js';
import { sendRoutes } from './routes/send.js';
import { claimRoutes } from './routes/claim.js';
import { activityRoutes } from './routes/activity.js';
import { ledgerRoutes } from './routes/ledger.js';
import { unsubscribeRoutes } from './routes/unsubscribe.js';
import { phantomRoutes } from './routes/phantom.js';
import { srpowRoutes } from './routes/srpow.js';

export interface AppConfig {
  sessionSecret: string;
  magicLinkBaseUrl: string;
  difficultyBits: number;
  difficultyFloor: number;
  mintMaxSupply: number;
  signingPrivateKeyHex: string;
  signingPublicKeyHex: string;
  webOrigin: string;
  secureCookies: boolean;
}

export interface BuildAppOptions {
  test?: boolean;
  pool: Pool;
  mailer: Mailer;
  config: AppConfig;
  bridgeClient: BridgeClient;
  wrapAllowlistCsv: string;          // raw CSV; parsed once on decoration
}

declare module 'fastify' {
  interface FastifyInstance {
    pool: Pool;
    mailer: Mailer;
    config: AppConfig;
    bridgeClient: BridgeClient;
    wrapAllowlist: Set<string>;
  }
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.test ? false : { level: 'info' },
    disableRequestLogging: !!opts.test,
    // Honor X-Forwarded-For only when the connection comes from nginx on
    // localhost. Without this, req.ip is always 127.0.0.1 in production and
    // the per-IP rate limit on /auth/request is useless. Loopback-only here so
    // arbitrary clients can't spoof their IP via the header.
    trustProxy: '127.0.0.1',
  });

  app.decorate('pool', opts.pool);
  app.decorate('mailer', opts.mailer);
  app.decorate('config', opts.config);
  app.decorate('bridgeClient', opts.bridgeClient);
  app.decorate('wrapAllowlist', parseAllowlist(opts.wrapAllowlistCsv));

  await app.register(cookie, { secret: opts.config.sessionSecret });
  await app.register(cors, {
    origin: opts.config.webOrigin,
    credentials: true,
  });

  app.get('/health', async () => ({ ok: true }));
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(challengeRoutes);
  await app.register(mintRoutes);
  await app.register(sendRoutes);
  await app.register(claimRoutes);
  await app.register(activityRoutes);
  await app.register(ledgerRoutes);
  await app.register(unsubscribeRoutes);
  await app.register(phantomRoutes);
  await app.register(srpowRoutes);

  app.get('/.well-known/rpow-pubkey.pem', async (_req, reply) => {
    const pubDer = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(app.config.signingPublicKeyHex, 'hex'),
    ]);
    const b64 = pubDer.toString('base64').match(/.{1,64}/g)!.join('\n');
    const pem = `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
    reply.header('content-type', 'application/x-pem-file').send(pem);
  });

  if (process.env.RPOW_TEST_INBOX === 'true') {
    app.get('/test/last-link/:email', async (req, reply) => {
      const email = decodeURIComponent((req.params as { email: string }).email).toLowerCase();
      const last = (app.mailer as any).lastTo?.(email);
      if (!last) return reply.code(404).send({ error: 'NO_LINK', message: `no magic link for ${email}` });
      const m = (last.text as string).match(/https?:\/\/[^\s]+token=[\w-]+/);
      if (!m) return reply.code(404).send({ error: 'NO_LINK', message: 'link not parseable' });
      const q = req.query as Record<string, string>;
      if (q.json === '1') return { link: m[0] };
      return reply.redirect(m[0], 302);
    });
  }

  return app;
}
