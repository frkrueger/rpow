import { createPool, runMigrations } from '../src/db.js';
import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { FakeMailer } from '../src/mailer.js';
import { buildApp } from '../src/buildApp.js';
import { FakeBridgeClient } from '@rpow/solana-bridge';
import pg from 'pg';

export async function makeTestApp(opts: {
  bridgeClient?: FakeBridgeClient;
  wrapAllowlistCsv?: string;
} = {}): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  pool: Pool;
  mailer: FakeMailer;
  bridgeClient: FakeBridgeClient;
  cleanup: () => Promise<void>;
}> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL required');

  const schema = `t_${randomBytes(4).toString('hex')}`;

  // Use an admin pool to create the schema
  const adminPool = createPool(url);
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  await adminPool.end();

  // Create a pool that always uses this schema via search_path
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    options: `-c search_path=${schema}`,
  });

  await runMigrations(pool);
  const mailer = new FakeMailer();
  const bridgeClient = opts.bridgeClient ?? new FakeBridgeClient();
  const app = await buildApp({
    pool,
    mailer,
    bridgeClient,
    wrapAllowlistCsv: opts.wrapAllowlistCsv ?? '',
    test: true,
    config: {
      sessionSecret: 'x'.repeat(32),
      magicLinkBaseUrl: 'http://test',
      difficultyBits: 8,
      difficultyFloor: 4,
      mintMaxSupply: 21,
      signingPrivateKeyHex: '11'.repeat(32),
      signingPublicKeyHex: 'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737',
      webOrigin: 'http://web.test',
      longShotWebOrigin: 'http://longshot.test',
      longShotMinBaseUnits: 10,
      longShotMaxBaseUnits: 1_000_000_000,
      longShotAllowedEmails: '*',
      gladiatorMinBetBaseUnits: 10,
      gladiatorMaxBetBaseUnits: 1_000_000_000,
      gladiatorMaxBankrollBaseUnits: 10_000_000_000,
      gladiatorSessionTtlHours: 48,
      gladiatorChatRetentionDays: 30,
      gladiatorAllowedEmails: '*',
      gladiatorWebOrigin: 'http://gladiator.test',
      secureCookies: false,
    },
  });
  return {
    app, pool, mailer, bridgeClient,
    cleanup: async () => {
      await app.close();
      // Use a fresh pool to drop the schema since main pool may be closed
      const cleanPool = createPool(url);
      await cleanPool.query(`DROP SCHEMA ${schema} CASCADE`);
      await cleanPool.end();
      await pool.end();
    },
  };
}
