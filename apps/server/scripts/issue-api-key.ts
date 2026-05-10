#!/usr/bin/env node
// Usage: tsx apps/server/scripts/issue-api-key.ts --email <email>
//
// Generates a fresh API key for <email>, replacing any existing key for that
// email. Prints the plaintext token ONCE to stdout — capture it now, it cannot
// be recovered.
//
// Env required: DATABASE_URL.
//
// In production:
//   ssh ubuntu@<host> 'sudo -u rpow node /opt/rpow/repo/apps/server/dist/scripts/issue-api-key.js --email rpow2swap@protonmail.com'

import { Pool } from 'pg';
import { randomBytes, createHash } from 'node:crypto';

function parseArgs(argv: string[]): { email: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--email' && argv[i + 1]) {
      out.email = argv[i + 1]!;
      i++;
    }
  }
  if (!out.email) throw new Error('Usage: --email <email>');
  return { email: out.email };
}

async function main() {
  const { email } = parseArgs(process.argv.slice(2));
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL required');

  const pool = new Pool({ connectionString: dbUrl });
  try {
    // Verify the user exists. Refuse to issue keys for ghost accounts.
    const u = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM users WHERE email = $1) AS exists`,
      [email],
    );
    if (!u.rows[0].exists) {
      console.error(`error: ${email} not found in users`);
      process.exit(2);
    }

    const suffix = randomBytes(32).toString('base64url');
    const plaintext = `rpow_sk_${suffix}`;
    const hash = createHash('sha256').update(plaintext).digest();
    const prefix = plaintext.slice(0, 12);

    await pool.query(
      `INSERT INTO api_keys(email, token_hash, token_prefix)
       VALUES($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET
         token_hash = EXCLUDED.token_hash,
         token_prefix = EXCLUDED.token_prefix,
         created_at = now(),
         last_used_at = NULL`,
      [email, hash, prefix],
    );

    process.stdout.write(`API key issued for ${email}\n`);
    process.stdout.write(`token (store securely — won't be shown again):\n\n`);
    process.stdout.write(`    ${plaintext}\n\n`);
    process.stdout.write(`prefix in DB: ${prefix}\n`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error(err.message ?? err);
  process.exit(1);
});
