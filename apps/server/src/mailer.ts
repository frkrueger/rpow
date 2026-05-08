import { Resend } from 'resend';
import { ServerClient as PostmarkClient } from 'postmark';
import nodemailer, { type Transporter } from 'nodemailer';

export interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}
export interface Mailer { send(args: SendArgs): Promise<void> }

export class ResendMailer implements Mailer {
  constructor(private apiKey: string, private from: string) {}
  async send(a: SendArgs): Promise<void> {
    const c = new Resend(this.apiKey);
    const { error } = await c.emails.send({
      from: this.from, to: a.to, subject: a.subject, html: a.html, text: a.text,
      headers: a.headers,
    });
    if (error) throw new Error(`resend: ${error.message}`);
  }
}

export class PostmarkMailer implements Mailer {
  private client: PostmarkClient;
  constructor(
    token: string,
    private from: string,
    private messageStream: string = 'outbound',
  ) {
    this.client = new PostmarkClient(token);
  }
  async send(a: SendArgs): Promise<void> {
    const Headers = a.headers
      ? Object.entries(a.headers).map(([Name, Value]) => ({ Name, Value }))
      : undefined;
    try {
      await this.client.sendEmail({
        From: this.from,
        To: a.to,
        Subject: a.subject,
        HtmlBody: a.html,
        TextBody: a.text,
        MessageStream: this.messageStream,
        Headers,
      });
    } catch (e: any) {
      throw new Error(`postmark: ${e?.message ?? e}`);
    }
  }
}

// SMTP fallback (Gmail-compatible: smtp.gmail.com:587 with an app password).
// Use as a stopgap when transactional providers (Resend/Postmark) are
// unavailable. The bound user account stays in Gmail's normal sending limits
// (free Gmail ~500/day, Workspace ~2000/day).
export class SmtpMailer implements Mailer {
  private transporter: Transporter;
  constructor(
    opts: { host: string; port: number; user?: string; pass?: string },
    private from: string,
  ) {
    this.transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.port === 465,
      auth: (opts.user && opts.pass) ? { user: opts.user, pass: opts.pass } : undefined,
    });
  }
  async send(a: SendArgs): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from, to: a.to, subject: a.subject, html: a.html, text: a.text,
        headers: a.headers,
      });
    } catch (e: any) {
      throw new Error(`smtp: ${e?.message ?? e}`);
    }
  }
}

// Outbound rate limiter for mail providers with hard per-second caps (e.g.
// Resend's default 5/s). Wraps any Mailer; paces send() at <= rps. If more
// than maxQueue calls are waiting, new send() throws ThrottleQueueFullError
// so the route handler can return 429 instead of hanging.
//
// Scheduler: monotonic-next-slot. Each send() reserves slot = max(now, nextAt),
// then advances nextAt by 1000/rps. Concurrent calls naturally serialize on
// the shared nextAt. queueDepth is the count of in-flight waiters (those that
// have reserved a slot but not yet returned from inner.send).
export class ThrottleQueueFullError extends Error {
  statusCode = 429;
  constructor() { super('outbound mail queue is full, retry in a moment'); }
}

export class ThrottledMailer implements Mailer {
  private nextAllowedAt = 0;
  private queueDepth = 0;
  private readonly intervalMs: number;
  constructor(
    private inner: Mailer,
    private opts: { rps: number; maxQueue: number },
  ) {
    if (opts.rps <= 0) throw new Error('ThrottledMailer: rps must be > 0');
    if (opts.maxQueue <= 0) throw new Error('ThrottledMailer: maxQueue must be > 0');
    this.intervalMs = 1000 / opts.rps;
  }
  async send(a: SendArgs): Promise<void> {
    if (this.queueDepth >= this.opts.maxQueue) {
      throw new ThrottleQueueFullError();
    }
    this.queueDepth++;
    try {
      const now = Date.now();
      const slot = Math.max(now, this.nextAllowedAt);
      this.nextAllowedAt = slot + this.intervalMs;
      const wait = slot - now;
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      await this.inner.send(a);
    } finally {
      this.queueDepth--;
    }
  }
}

export class FakeMailer implements Mailer {
  outbox: SendArgs[] = [];
  async send(a: SendArgs): Promise<void> { this.outbox.push(a); }
  lastTo(addr: string): SendArgs | undefined { return [...this.outbox].reverse().find(m => m.to === addr); }
}
