import { parseEnv } from './env.js';
import { createPool, runMigrations } from './db.js';
import { buildApp } from './buildApp.js';
import { ResendMailer, PostmarkMailer, SmtpMailer, FakeMailer, ThrottledMailer, type Mailer } from './mailer.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { SolanaBridgeClient, FakeBridgeClient, type BridgeClient, SRPOW_BASE_UNITS_PER_RPOW } from '@rpow/solana-bridge';
import { loadBridgeKeypair } from './bridge-keys.js';
import { reconcilePendingWraps } from './srpow-reconcile.js';

const env = parseEnv();
const pool = createPool(env.DATABASE_URL);
await runMigrations(pool);

let bridgeClient: BridgeClient;
if (env.SOLANA_RPC_URL && env.SRPOW_MINT_ADDRESS && env.BRIDGE_KEYPAIR_BASE58) {
  const conn = new Connection(env.SOLANA_RPC_URL, env.SRPOW_COMMITMENT);
  bridgeClient = new SolanaBridgeClient({
    connection: conn,
    bridge: loadBridgeKeypair(env.BRIDGE_KEYPAIR_BASE58),
    mint: new PublicKey(env.SRPOW_MINT_ADDRESS),
    commitment: env.SRPOW_COMMITMENT,
    baseUnitsPerToken: SRPOW_BASE_UNITS_PER_RPOW,
    timeoutMs: env.SRPOW_WRAP_TIMEOUT_MS,
  });
} else {
  // Wrap is disabled at boot if SRPOW envs aren't all set.
  bridgeClient = new FakeBridgeClient();
  console.log('SRPOW disabled: SOLANA_RPC_URL/SRPOW_MINT_ADDRESS/BRIDGE_KEYPAIR_BASE58 not all set');
}

if (env.SOLANA_RPC_URL && env.SRPOW_MINT_ADDRESS && env.BRIDGE_KEYPAIR_BASE58) {
  await reconcilePendingWraps(pool, bridgeClient);
} else {
  console.log('SRPOW disabled: skipping reconcile worker');
}

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
} else if (env.MAILER === 'postmark') {
  mailer = new PostmarkMailer(env.POSTMARK_TOKEN!, env.EMAIL_FROM, env.POSTMARK_MESSAGE_STREAM);
} else if (env.MAILER === 'smtp') {
  mailer = new SmtpMailer(
    { host: env.SMTP_HOST!, port: env.SMTP_PORT, user: env.SMTP_USER!, pass: env.SMTP_PASS! },
    env.EMAIL_FROM,
  );
} else {
  mailer = new ResendMailer(env.RESEND_API_KEY!, env.EMAIL_FROM);
}

// Wrap the chosen provider with an outbound rate limiter so we never exceed
// the provider's per-second cap (Resend default is 5/s). FakeMailer used in
// RPOW_TEST_INBOX mode is left untouched so dev consoles see links instantly.
if (process.env.RPOW_TEST_INBOX !== 'true') {
  mailer = new ThrottledMailer(mailer, {
    rps: env.MAIL_THROTTLE_RPS,
    maxQueue: env.MAIL_THROTTLE_MAX_QUEUE,
  });
  console.log(`mail throttle: ${env.MAIL_THROTTLE_RPS} req/s, queue cap ${env.MAIL_THROTTLE_MAX_QUEUE}`);
}

const app = await buildApp({
  pool,
  mailer,
  bridgeClient,
  wrapAllowlistCsv: env.WRAP_ALLOWED_EMAILS,
  config: {
    sessionSecret: env.SESSION_SECRET,
    magicLinkBaseUrl: env.MAGIC_LINK_BASE_URL,
    difficultyBits: env.DIFFICULTY_BITS,
    difficultyFloor: env.DIFFICULTY_FLOOR,
    mintMaxSupply: env.MINT_MAX_SUPPLY,
    signingPrivateKeyHex: env.RPOW_SIGNING_PRIVATE_KEY_HEX,
    signingPublicKeyHex: env.RPOW_SIGNING_PUBLIC_KEY_HEX,
    webOrigin: env.WEB_ORIGIN,
    secureCookies: env.NODE_ENV === 'production',
  },
});
await app.listen({ host: '0.0.0.0', port: env.PORT });
app.log.info(`rpow2 server listening on :${env.PORT}`);
