import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hmac(secret: string, payload: string): string {
  return b64url(createHmac('sha256', secret).update(payload).digest());
}

export function makeUnsubToken(email: string, secret: string): string {
  const e = b64url(Buffer.from(email.toLowerCase().trim(), 'utf8'));
  return `${e}.${hmac(secret, e)}`;
}

export function verifyUnsubToken(token: string, secret: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [e, sig] = parts;
  const expected = hmac(secret, e);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    return Buffer.from(e.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export async function isUnsubscribed(pool: Pool, email: string): Promise<boolean> {
  const { rows } = await pool.query<{ email: string }>(
    `SELECT email FROM email_unsubscribes WHERE email=$1`,
    [email.toLowerCase().trim()],
  );
  return rows.length > 0;
}

export async function recordUnsubscribe(pool: Pool, email: string): Promise<void> {
  await pool.query(
    `INSERT INTO email_unsubscribes(email) VALUES($1) ON CONFLICT (email) DO NOTHING`,
    [email.toLowerCase().trim()],
  );
}
