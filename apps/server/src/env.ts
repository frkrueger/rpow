import { z } from 'zod';

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().url(),
  MAILER: z.enum(['resend', 'postmark', 'smtp']).default('resend'),
  RESEND_API_KEY: z.string().min(1).optional(),
  POSTMARK_TOKEN: z.string().min(1).optional(),
  POSTMARK_MESSAGE_STREAM: z.string().min(1).default('outbound'),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  EMAIL_FROM: z.string().email().or(z.string().regex(/^[^@<>]+<[^@<>]+@[^@<>]+>$/)),
  SESSION_SECRET: z.string().min(32),
  MAGIC_LINK_BASE_URL: z.string().url(),
  RPOW_SIGNING_PRIVATE_KEY_HEX: z.string().regex(/^[0-9a-f]{64}$/),
  RPOW_SIGNING_PUBLIC_KEY_HEX: z.string().regex(/^[0-9a-f]{64}$/),
  DIFFICULTY_BITS: z.coerce.number().int().min(4).max(40).default(28),
  DIFFICULTY_FLOOR: z.coerce.number().int().min(4).max(40).default(20),
  MINT_EPOCH_SIZE: z.coerce.number().int().positive().default(1_000_000),
  MINT_MAX_SUPPLY: z.coerce.number().int().positive().default(21_000_000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  TURNSTILE_SECRET: z.string().optional(),
}).superRefine((v, ctx) => {
  if (v.MAILER === 'resend' && !v.RESEND_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['RESEND_API_KEY'], message: 'required when MAILER=resend' });
  }
  if (v.MAILER === 'postmark' && !v.POSTMARK_TOKEN) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['POSTMARK_TOKEN'], message: 'required when MAILER=postmark' });
  }
  if (v.MAILER === 'smtp') {
    if (!v.SMTP_HOST) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SMTP_HOST'], message: 'required when MAILER=smtp' });
    if (!v.SMTP_USER) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SMTP_USER'], message: 'required when MAILER=smtp' });
    if (!v.SMTP_PASS) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SMTP_PASS'], message: 'required when MAILER=smtp' });
  }
});

export type Env = z.infer<typeof Schema>;

export function parseEnv(raw: Record<string, string | undefined> = process.env): Env {
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`invalid env: ${msg}`);
  }
  return parsed.data;
}
