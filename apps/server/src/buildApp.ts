import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import type { Pool } from 'pg';
import type { Mailer } from './mailer.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { challengeRoutes } from './routes/challenge.js';

export interface AppConfig {
  sessionSecret: string;
  magicLinkBaseUrl: string;
  difficultyBits: number;
  difficultyFloor: number;
  signingPrivateKeyHex: string;
  signingPublicKeyHex: string;
  webOrigin: string;
}

export interface BuildAppOptions {
  test?: boolean;
  pool: Pool;
  mailer: Mailer;
  config: AppConfig;
}

declare module 'fastify' {
  interface FastifyInstance {
    pool: Pool;
    mailer: Mailer;
    config: AppConfig;
  }
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.test ? false : { level: 'info' },
    disableRequestLogging: !!opts.test,
  });

  app.decorate('pool', opts.pool);
  app.decorate('mailer', opts.mailer);
  app.decorate('config', opts.config);

  await app.register(cookie, { secret: opts.config.sessionSecret });
  await app.register(cors, {
    origin: opts.config.webOrigin,
    credentials: true,
  });

  app.get('/health', async () => ({ ok: true }));
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(challengeRoutes);

  return app;
}
