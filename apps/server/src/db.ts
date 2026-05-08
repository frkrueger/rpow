import { Pool, type PoolClient } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createPool(databaseUrl: string): Pool {
  // Postgres default max_connections is 100; 30 leaves plenty of headroom
  // for backups (pg_dump uses 1) and the postgres role's own sessions.
  // 10 was bottlenecking under thousands of concurrent users.
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

export async function withClient<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { return await fn(c); } finally { c.release(); }
}

export async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally { c.release(); }
}

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const dir = join(__dirname, '..', 'migrations');
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [f]);
    if (rows.length) continue;
    const sql = await readFile(join(dir, f), 'utf8');
    await withTx(pool, async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(filename) VALUES($1)', [f]);
    });
  }
}
