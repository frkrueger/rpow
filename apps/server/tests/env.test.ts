import { describe, it, expect } from 'vitest';
import { parseEnv } from '../src/env.js';

describe('parseEnv', () => {
  it('parses a valid env', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgres://u:p@h/db',
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'no-reply@rpow2.com',
      SESSION_SECRET: 'a'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://localhost:8080',
      RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
      RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
      DIFFICULTY_BITS: '8',
    });
    expect(env.DIFFICULTY_BITS).toBe(8);
  });
  it('rejects when DATABASE_URL missing', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });
  it('rejects MAILER=postmark without POSTMARK_TOKEN', () => {
    expect(() => parseEnv({
      DATABASE_URL: 'postgres://u:p@h/db',
      MAILER: 'postmark',
      EMAIL_FROM: 'no-reply@rpow2.com',
      SESSION_SECRET: 'a'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://localhost:8080',
      RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
      RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
    })).toThrow(/POSTMARK_TOKEN/);
  });
  it('rejects MAILER=resend without RESEND_API_KEY', () => {
    expect(() => parseEnv({
      DATABASE_URL: 'postgres://u:p@h/db',
      EMAIL_FROM: 'no-reply@rpow2.com',
      SESSION_SECRET: 'a'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://localhost:8080',
      RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
      RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
    })).toThrow(/RESEND_API_KEY/);
  });
  it('rejects MAILER=smtp without SMTP_HOST/USER/PASS', () => {
    expect(() => parseEnv({
      DATABASE_URL: 'postgres://u:p@h/db',
      MAILER: 'smtp',
      EMAIL_FROM: 'no-reply@rpow2.com',
      SESSION_SECRET: 'a'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://localhost:8080',
      RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
      RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
    })).toThrow(/SMTP_HOST|SMTP_USER|SMTP_PASS/);
  });
  it('accepts MAILER=smtp with all SMTP_* set', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgres://u:p@h/db',
      MAILER: 'smtp',
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_USER: 'test@gmail.com',
      SMTP_PASS: 'app-password',
      EMAIL_FROM: 'no-reply@rpow2.com',
      SESSION_SECRET: 'a'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://localhost:8080',
      RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
      RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
    });
    expect(env.MAILER).toBe('smtp');
    expect(env.SMTP_PORT).toBe(587);
  });
  it('accepts MAILER=postmark with POSTMARK_TOKEN', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgres://u:p@h/db',
      MAILER: 'postmark',
      POSTMARK_TOKEN: 'pm_test',
      EMAIL_FROM: 'no-reply@rpow2.com',
      SESSION_SECRET: 'a'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://localhost:8080',
      RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
      RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
    });
    expect(env.MAILER).toBe('postmark');
    expect(env.POSTMARK_MESSAGE_STREAM).toBe('outbound');
  });
  it('defaults SRPOW envs sensibly', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgres://u:p@h/db',
      RESEND_API_KEY: 'rk',
      EMAIL_FROM: 'no-reply@rpow2.com',
      SESSION_SECRET: 'a'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://localhost:8080',
      RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
      RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
    });
    expect(env.WRAP_ALLOWED_EMAILS).toBe('');
    expect(env.SRPOW_COMMITMENT).toBe('confirmed');
    expect(env.SRPOW_WRAP_TIMEOUT_MS).toBe(60_000);
  });
});
