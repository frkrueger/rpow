import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashToken, issueMagicLink } from '../magic.js';
import { signSession, SESSION_COOKIE, SESSION_TTL_SECONDS, verifySession } from '../session.js';

const RequestBody = z.object({ email: z.string().email() });

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/request', async (req, reply) => {
    const parsed = RequestBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid email' });
    const email = parsed.data.email.toLowerCase().trim();
    const ip = (req.ip ?? '0.0.0.0');

    const cooldown = await app.pool.query<{ created_at: Date }>(
      `SELECT created_at FROM magic_links WHERE email=$1 ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
    if (cooldown.rows[0]) {
      const elapsedMs = Date.now() - cooldown.rows[0].created_at.getTime();
      if (elapsedMs < 30_000) {
        return reply.code(429).send({ error: 'RATE_LIMITED', message: 'try again shortly', retry_after: Math.ceil((30_000 - elapsedMs) / 1000) });
      }
    }

    const perEmail = await app.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM magic_links WHERE email=$1 AND created_at > now() - interval '1 hour'`,
      [email],
    );
    if ((perEmail.rows[0]?.n ?? 0) >= 30) {
      return reply.code(429).send({ error: 'RATE_LIMITED', message: 'too many attempts on this email; try again later', retry_after: 60 * 30 });
    }

    // Per-IP cap is generous so corporate/home NATs aren't penalized when many
    // genuine users sign up from the same egress IP. Per-email cap is the real
    // anti-spam lever; per-IP only catches scripted attacks.
    const perIp = await app.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM magic_links WHERE ip_addr=$1 AND created_at > now() - interval '1 hour'`,
      [ip],
    );
    if ((perIp.rows[0]?.n ?? 0) >= 1000) {
      return reply.code(429).send({ error: 'RATE_LIMITED', message: 'too many attempts from this network', retry_after: 60 * 30 });
    }

    const { token, hash } = issueMagicLink();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await app.pool.query(
      'INSERT INTO magic_links(id, email, token_hash, expires_at, ip_addr) VALUES($1,$2,$3,$4,$5)',
      [id, email, hash, expiresAt, ip],
    );
    const link = `${app.config.magicLinkBaseUrl}/auth/verify?token=${token}`;
    await app.mailer.send({
      to: email,
      subject: 'rpow2 — your magic link',
      text: `Click to sign in:\n${link}\n\nLink expires in 15 minutes.`,
      html: `<p>Click to sign in to <a href="${link}">rpow2</a>.</p><p><a href="${link}">${link}</a></p><p>Link expires in 15 minutes.</p>`,
    });

    return { ok: true, cooldown_seconds: 30 };
  });

  app.get('/auth/verify', async (req, reply) => {
    const token = (req.query as Record<string, string>).token;
    if (!token) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'missing token' });

    const tokenHash = hashToken(token);
    const { rows } = await app.pool.query(
      'SELECT id, email, expires_at, used_at FROM magic_links WHERE token_hash=$1 AND expires_at > now() AND used_at IS NULL',
      [tokenHash],
    );
    const match = rows[0];
    if (!match) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid or expired link' });

    await app.pool.query('UPDATE magic_links SET used_at=now() WHERE id=$1', [match.id]);

    await app.pool.query(
      `INSERT INTO users(email) VALUES($1)
       ON CONFLICT (email) DO UPDATE SET last_login_at = now()`,
      [match.email],
    );

    const sessionToken = signSession({ email: match.email }, app.config.sessionSecret, SESSION_TTL_SECONDS);
    reply.setCookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true, secure: app.config.secureCookies,
      sameSite: 'lax', path: '/', maxAge: SESSION_TTL_SECONDS,
    });
    return reply.redirect(`${app.config.webOrigin}/#/wallet`, 302);
  });

  app.post('/auth/logout', async (req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}

export function readSession(req: { cookies: Record<string, string | undefined> }, secret: string): { email: string } | null {
  const tok = req.cookies[SESSION_COOKIE];
  if (!tok) return null;
  return verifySession(tok, secret);
}
