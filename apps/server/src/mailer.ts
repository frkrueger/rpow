import { Resend } from 'resend';
import { ServerClient as PostmarkClient } from 'postmark';

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
      throw new Error(`postmark: ${e?.message ?? e}`, { cause: e });
    }
  }
}

export class FakeMailer implements Mailer {
  outbox: SendArgs[] = [];
  async send(a: SendArgs): Promise<void> { this.outbox.push(a); }
  lastTo(addr: string): SendArgs | undefined { return [...this.outbox].reverse().find(m => m.to === addr); }
}
