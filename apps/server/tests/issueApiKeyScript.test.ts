import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { makeTestApp } from './helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('scripts/issue-api-key.ts', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('issues a key for an existing email and the key authenticates /me', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES($1)`, ['op@example.com']);

    // Run the script with DATABASE_URL pointed at our test schema.
    // The makeTestApp pool sets search_path via options; reproduce that.
    const url = process.env.TEST_DATABASE_URL!;
    const schema = (ctx.pool as any).options.options.match(/search_path=(\w+)/)![1];
    const dbUrl = `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;

    const scriptPath = join(__dirname, '..', 'scripts', 'issue-api-key.ts');
    const result = spawnSync(
      'npx', ['tsx', scriptPath, '--email', 'op@example.com'],
      { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    const tokenMatch = result.stdout.match(/(rpow_sk_[A-Za-z0-9_-]+)/);
    expect(tokenMatch).not.toBeNull();
    const plaintext = tokenMatch![1];

    // Use the issued token to hit /me
    const res = await ctx.app.inject({
      method: 'GET', url: '/me',
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe('op@example.com');
  });

  it('fails with non-zero exit when --email does not exist in users', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const url = process.env.TEST_DATABASE_URL!;
    const schema = (ctx.pool as any).options.options.match(/search_path=(\w+)/)![1];
    const dbUrl = `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    const scriptPath = join(__dirname, '..', 'scripts', 'issue-api-key.ts');

    const result = spawnSync(
      'npx', ['tsx', scriptPath, '--email', 'nosuch@example.com'],
      { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not found in users/);
  });

  it('rotates: re-running invalidates the previous token', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES($1)`, ['rot@example.com']);
    const url = process.env.TEST_DATABASE_URL!;
    const schema = (ctx.pool as any).options.options.match(/search_path=(\w+)/)![1];
    const dbUrl = `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    const scriptPath = join(__dirname, '..', 'scripts', 'issue-api-key.ts');

    const first = spawnSync('npx', ['tsx', scriptPath, '--email', 'rot@example.com'], { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' });
    const t1 = first.stdout.match(/(rpow_sk_[A-Za-z0-9_-]+)/)![1];

    const second = spawnSync('npx', ['tsx', scriptPath, '--email', 'rot@example.com'], { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' });
    const t2 = second.stdout.match(/(rpow_sk_[A-Za-z0-9_-]+)/)![1];
    expect(t1).not.toBe(t2);

    // Old token should now fail
    const oldRes = await ctx.app.inject({
      method: 'GET', url: '/me',
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(oldRes.statusCode).toBe(401);

    // New token should work
    const newRes = await ctx.app.inject({
      method: 'GET', url: '/me',
      headers: { authorization: `Bearer ${t2}` },
    });
    expect(newRes.statusCode).toBe(200);
  });
});
