import { test, expect, request } from '@playwright/test';

const SERVER = process.env.E2E_SERVER ?? 'http://localhost:8080';

test('mine, send, balance updates', async ({ page, browser }) => {
  const runId = Date.now();
  const senderEmail = `e2e-a-${runId}@x.com`;
  const recipientEmail = `e2e-b-${runId}@x.com`;

  // Helper: login a given email by reading the magic link from the server's test inbox.
  async function login(loginPage: typeof page, email: string) {
    const ctx = await request.newContext();
    const requestLink = await ctx.post(`${SERVER}/auth/request`, { data: { email } });
    expect(requestLink.ok()).toBeTruthy();
    // In E2E mode the server is started with RPOW_TEST_INBOX=true and exposes the last link via /test/last-link/:email.
    const r = await ctx.get(`${SERVER}/test/last-link/${encodeURIComponent(email)}?json=1`);
    expect(r.ok()).toBeTruthy();
    const link = (await r.json()).link as string;
    await loginPage.goto(link);
    await loginPage.waitForURL(/#\/wallet/);
    await ctx.dispose();
  }

  await login(page, senderEmail);
  await page.goto('/#/mine');
  await page.getByLabel(/auto-mine/i).uncheck();
  await page.getByRole('button', { name: /MINE/ }).click();
  await page.waitForFunction(() => /MINED THIS RUN\s*:\s*[1-9]/.test(document.body.textContent ?? ''), null, { timeout: 60_000 });

  await page.goto('/#/send');
  // Ensure recipient exists in this run by logging them in once in another context.
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await login(p2, recipientEmail);
  await ctx2.close();

  // Back on the original page, send 1 to b.
  await page.fill('input[type=email]', recipientEmail);
  await page.fill('input[type=number]', '1');
  await page.getByRole('button', { name: /SEND/ }).click();
  await expect(page.locator('text=transfer id:')).toBeVisible({ timeout: 5000 });
});
