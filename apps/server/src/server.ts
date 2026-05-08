import { parseEnv } from './env.js';
import { createPool, runMigrations } from './db.js';
import { buildApp } from './buildApp.js';
import { ResendMailer, FakeMailer, type Mailer } from './mailer.js';

const env = parseEnv();
const pool = createPool(env.DATABASE_URL);
await runMigrations(pool);

let mailer: Mailer;
if (process.env.RPOW_TEST_INBOX === 'true') {
  const fake = new FakeMailer();
  const orig = fake.send.bind(fake);
  fake.send = async (a) => {
    await orig(a);
    const m = a.text.match(/https?:\/\/[^\s]+token=[\w-]+/);
    console.log(`\n[magic link for ${a.to}]\n  ${m?.[0] ?? '(no link parsed)'}\n`);
  };
  mailer = fake;
  console.log('using FakeMailer (RPOW_TEST_INBOX=true) — magic links print to this console');
} else {
  mailer = new ResendMailer(env.RESEND_API_KEY, env.EMAIL_FROM);
}

const app = await buildApp({
  pool,
  mailer,
  config: {
    sessionSecret: env.SESSION_SECRET,
    magicLinkBaseUrl: env.MAGIC_LINK_BASE_URL,
    difficultyBits: env.DIFFICULTY_BITS,
    difficultyFloor: env.DIFFICULTY_FLOOR,
    mintEpochSize: env.MINT_EPOCH_SIZE,
    mintMaxSupply: env.MINT_MAX_SUPPLY,
    signingPrivateKeyHex: env.RPOW_SIGNING_PRIVATE_KEY_HEX,
    signingPublicKeyHex: env.RPOW_SIGNING_PUBLIC_KEY_HEX,
    webOrigin: env.WEB_ORIGIN,
    secureCookies: env.NODE_ENV === 'production',
  },
});
await app.listen({ host: '0.0.0.0', port: env.PORT });
app.log.info(`rpow2 server listening on :${env.PORT}`);
