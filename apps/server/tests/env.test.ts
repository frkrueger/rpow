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

  it('parses LONGSHOT_MIN_BASE_UNITS and LONGSHOT_MAX_BASE_UNITS with defaults', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgres://u:p@h/db',
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'no-reply@rpow2.com',
      SESSION_SECRET: 'a'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://localhost:8080',
      RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
      RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
    });
    // Defaults: 0.01 RPOW = 10_000_000 base units, 10 RPOW = 10_000_000_000 base units
    expect(env.LONGSHOT_MIN_BASE_UNITS).toBe(10_000_000);
    expect(env.LONGSHOT_MAX_BASE_UNITS).toBe(10_000_000_000);
  });

  it('LONGSHOT_ALLOWED_EMAILS defaults to frkrueger@mac.com', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgres://u:p@h/db',
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'no-reply@rpow2.com',
      SESSION_SECRET: 'a'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://localhost:8080',
      RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
      RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
    });
    expect(env.LONGSHOT_ALLOWED_EMAILS).toBe('frkrueger@mac.com');
  });

  it('LONGSHOT_ALLOWED_EMAILS = * opens access to all', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgres://u:p@h/db',
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'no-reply@rpow2.com',
      SESSION_SECRET: 'a'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://localhost:8080',
      RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
      RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
      LONGSHOT_ALLOWED_EMAILS: '*',
    });
    expect(env.LONGSHOT_ALLOWED_EMAILS).toBe('*');
  });

  it('rejects LONGSHOT_MAX_BASE_UNITS less than LONGSHOT_MIN_BASE_UNITS', () => {
    expect(() => parseEnv({
      DATABASE_URL: 'postgres://u:p@h/db',
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'no-reply@rpow2.com',
      SESSION_SECRET: 'a'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://localhost:8080',
      RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
      RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
      LONGSHOT_MIN_BASE_UNITS: '1000000000',
      LONGSHOT_MAX_BASE_UNITS: '100',
    })).toThrow();
  });

  it('parses GLADIATOR_* vars with defaults', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgres://u:p@h/db',
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'no-reply@rpow2.com',
      SESSION_SECRET: 'a'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://localhost:8080',
      RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
      RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
    });
    expect(env.GLADIATOR_MIN_BET_BASE_UNITS).toBe(10_000_000);
    expect(env.GLADIATOR_MAX_BET_BASE_UNITS).toBe(10_000_000_000);
    expect(env.GLADIATOR_MAX_BANKROLL_BASE_UNITS).toBe(100_000_000_000);
    expect(env.GLADIATOR_SESSION_TTL_HOURS).toBe(48);
    expect(env.GLADIATOR_CHAT_RETENTION_DAYS).toBe(30);
    expect(env.GLADIATOR_ALLOWED_EMAILS).toBe('*');
    expect(env.GLADIATOR_WEB_ORIGIN).toBe('https://gladiator.rpow2.com');
  });

  it('rejects GLADIATOR_MAX_BET_BASE_UNITS less than GLADIATOR_MIN_BET_BASE_UNITS', () => {
    expect(() => parseEnv({
      DATABASE_URL: 'postgres://u:p@h/db',
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'no-reply@rpow2.com',
      SESSION_SECRET: 'a'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://localhost:8080',
      RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
      RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
      GLADIATOR_MIN_BET_BASE_UNITS: '1000000000',
      GLADIATOR_MAX_BET_BASE_UNITS: '100',
    })).toThrow();
  });

  it('rejects GLADIATOR_MAX_BANKROLL_BASE_UNITS less than GLADIATOR_MAX_BET_BASE_UNITS', () => {
    expect(() => parseEnv({
      DATABASE_URL: 'postgres://u:p@h/db',
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'no-reply@rpow2.com',
      SESSION_SECRET: 'a'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://localhost:8080',
      RPOW_SIGNING_PRIVATE_KEY_HEX: '00'.repeat(32),
      RPOW_SIGNING_PUBLIC_KEY_HEX: '00'.repeat(32),
      GLADIATOR_MAX_BET_BASE_UNITS: '1000000000',
      GLADIATOR_MAX_BANKROLL_BASE_UNITS: '100',
    })).toThrow();
  });

  it('parses TRIVIA defaults', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgres://x/y',
      RESEND_API_KEY: 'rk_test',
      SESSION_SECRET: 'x'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://x/',
      RPOW_SIGNING_PRIVATE_KEY_HEX: 'a'.repeat(64),
      RPOW_SIGNING_PUBLIC_KEY_HEX: 'b'.repeat(64),
      EMAIL_FROM: 'a@b.com',
    });
    expect(env.TRIVIA_MIN_BET_BASE_UNITS).toBe(10_000_000);
    expect(env.TRIVIA_MAX_BET_BASE_UNITS).toBe(10_000_000_000);
    expect(env.TRIVIA_MAX_BANKROLL_BASE_UNITS).toBe(100_000_000_000);
    expect(env.TRIVIA_MATCH_DEADLINE_SECONDS).toBe(10);
    expect(env.TRIVIA_SESSION_TTL_HOURS).toBe(48);
    expect(env.TRIVIA_ALLOWED_EMAILS).toBe('*');
    expect(env.TRIVIA_WEB_ORIGIN).toBe('https://trivia.rpow2.com');
  });

  it('rejects TRIVIA_MAX_BET < TRIVIA_MIN_BET', () => {
    expect(() => parseEnv({
      DATABASE_URL: 'postgres://x/y',
      RESEND_API_KEY: 'rk_test',
      SESSION_SECRET: 'x'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://x/',
      RPOW_SIGNING_PRIVATE_KEY_HEX: 'a'.repeat(64),
      RPOW_SIGNING_PUBLIC_KEY_HEX: 'b'.repeat(64),
      EMAIL_FROM: 'a@b.com',
      TRIVIA_MIN_BET_BASE_UNITS: '100',
      TRIVIA_MAX_BET_BASE_UNITS: '50',
    })).toThrow();
  });

  it('rejects TRIVIA_MAX_BANKROLL < TRIVIA_MAX_BET', () => {
    expect(() => parseEnv({
      DATABASE_URL: 'postgres://x/y',
      RESEND_API_KEY: 'rk_test',
      SESSION_SECRET: 'x'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://x/',
      RPOW_SIGNING_PRIVATE_KEY_HEX: 'a'.repeat(64),
      RPOW_SIGNING_PUBLIC_KEY_HEX: 'b'.repeat(64),
      EMAIL_FROM: 'a@b.com',
      TRIVIA_MAX_BET_BASE_UNITS: '1000',
      TRIVIA_MAX_BANKROLL_BASE_UNITS: '500',
    })).toThrow();
  });
});
