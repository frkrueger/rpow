import { defineConfig } from '@playwright/test';

const apiURL = process.env.E2E_SERVER ?? 'http://localhost:8080';
const webURL = process.env.E2E_WEB ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: webURL, headless: true },
  webServer: [
    {
      command: 'npm --prefix ../.. run dev:server',
      url: `${apiURL}/ready`,
      env: {
        ...process.env,
        PORT: '8080',
        DATABASE_URL: process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgres://postgres:p@localhost:55432/postgres',
        RESEND_API_KEY: 'e2e_fake_resend_key',
        EMAIL_FROM: 'rpow e2e <no-reply@rpow2.test>',
        SESSION_SECRET: 'e2e-session-secret-at-least-thirty-two-bytes',
        MAGIC_LINK_BASE_URL: apiURL,
        WEB_ORIGIN: webURL,
        RPOW_SIGNING_PRIVATE_KEY_HEX: 'd277373c0236e3aed569a22b68b9a3514d61cf6300897c185097c178089e7eb7',
        RPOW_SIGNING_PUBLIC_KEY_HEX: '53d8804809269fa651f0c018c8c2c4140e6233395104134398eff521eddfa22f',
        RPOW_TEST_INBOX: 'true',
        DIFFICULTY_BITS: '4',
        DIFFICULTY_FLOOR: '4',
      },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm --prefix ../.. run dev:web',
      url: webURL,
      env: {
        ...process.env,
        VITE_API_BASE_URL: apiURL,
      },
      reuseExistingServer: !process.env.CI,
    },
  ],
});
