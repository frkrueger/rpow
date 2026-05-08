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
    opts: { host: string; port: number; user: string; pass: string },
    private from: string,
  ) {
    this.transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.port === 465,
      auth: { user: opts.user, pass: opts.pass },
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

export class FakeMailer implements Mailer {
  outbox: SendArgs[] = [];
  async send(a: SendArgs): Promise<void> { this.outbox.push(a); }
  lastTo(addr: string): SendArgs | undefined { return [...this.outbox].reverse().find(m => m.to === addr); }
}
