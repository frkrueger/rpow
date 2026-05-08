import type { FastifyInstance } from 'fastify';
import { verifyUnsubToken, recordUnsubscribe } from '../unsub.js';

export async function unsubscribeRoutes(app: FastifyInstance) {
  // RFC 8058 one-click POST. ESPs hit this with body `List-Unsubscribe=One-Click`.
  app.post('/unsubscribe', async (req, reply) => {
    const token = (req.query as Record<string, string>).token;
    if (!token) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'missing token' });
    const email = verifyUnsubToken(token, app.config.sessionSecret);
    if (!email) return reply.code(400).send({ error: 'BAD_TOKEN', message: 'invalid token' });
    await recordUnsubscribe(app.pool, email);
    return reply.code(200).send({ ok: true });
  });

  // Browser-initiated GET: unsubscribe and show a small confirmation page.
  app.get('/unsubscribe', async (req, reply) => {
    const token = (req.query as Record<string, string>).token;
    if (!token) return reply.code(400).type('text/html').send(page('missing or invalid link'));
    const email = verifyUnsubToken(token, app.config.sessionSecret);
    if (!email) return reply.code(400).type('text/html').send(page('invalid link'));
    await recordUnsubscribe(app.pool, email);
    return reply.code(200).type('text/html').send(page(`<strong>${escapeHtml(email)}</strong> has been unsubscribed from RPOW token-claim emails. Magic-link sign-in emails (when you log in) will still be sent.`));
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function page(body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>rpow2 — unsubscribe</title>
<style>body{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;background:#0b0b0b;color:#e8e3d3;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}.c{max-width:520px;text-align:center;line-height:1.5}.c a{color:#6ee7b7}</style>
</head><body><div class="c">${body}<p style="margin-top:24px;font-size:11px;color:#888;">rpow2.com — a modern tribute to a tribute to the original rpow by hal finney</p></div></body></html>`;
}
