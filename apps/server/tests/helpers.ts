import { createPool, runMigrations } from '../src/db.js';
import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { FakeMailer } from '../src/mailer.js';
import { buildApp } from '../src/buildApp.js';
import pg from 'pg';

export async function makeTestApp(): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  pool: Pool;
  mailer: FakeMailer;
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
  const app = await buildApp({
    pool,
    mailer,
    test: true,
    config: {
      sessionSecret: 'x'.repeat(32),
      magicLinkBaseUrl: 'http://test',
      difficultyBits: 8,
      difficultyFloor: 4,
      mintEpochSize: 10,
      mintMaxSupply: 21,
      signingPrivateKeyHex: '11'.repeat(32),
      signingPublicKeyHex: '22'.repeat(32),
      webOrigin: 'http://web.test',
      secureCookies: false,
    },
  });
  return {
    app, pool, mailer,
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
