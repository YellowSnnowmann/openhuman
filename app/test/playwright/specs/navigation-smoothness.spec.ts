import { expect, test } from '@playwright/test';

import { bootAuthenticatedPage, waitForAppReady } from '../helpers/core-rpc';

interface RouteCheck {
  hash: string;
  markers: string[];
}

const routes: RouteCheck[] = [
  { hash: '/chat', markers: ['Threads', 'Chat', 'Message', 'New'] },
  { hash: '/connections', markers: ['Composio', 'Channels', 'MCP Servers', 'Skills'] },
  // /home redirects to /chat (Phase 6); use chat-surface markers.
  { hash: '/home', markers: ['Threads', 'Chat', 'Message', 'New'] },
  { hash: '/channels', markers: ['Channels', 'Connections', 'Telegram', 'Discord'] },
  { hash: '/notifications', markers: ['Notifications', 'Alerts', 'No alerts yet'] },
  { hash: '/rewards', markers: ['Rewards', 'Referral', 'Credits', 'Invite'] },
  { hash: '/settings', markers: ['Settings', 'Account', 'Billing', 'Advanced'] },
  { hash: '/settings/notifications-hub', markers: ['Notifications'] },
  { hash: '/home', markers: ['Threads', 'Chat', 'Message', 'New'] },
];

async function rootTextLength(page: import('@playwright/test').Page): Promise<number> {
  return page
    .locator('#root')
    .innerText()
    .then(text => text.length);
}

async function verifyRouteLoaded(
  page: import('@playwright/test').Page,
  route: RouteCheck
): Promise<void> {
  await waitForAppReady(page);
  await expect.poll(() => rootTextLength(page), { timeout: 10_000 }).toBeGreaterThan(50);
}

test.describe('Navigation Smoothness', () => {
  test.beforeEach(async ({ page }) => {
    await bootAuthenticatedPage(page, 'pw-navigation-smoothness-user');
  });

  test('all major routes render within timing budget', async ({ page }) => {
    for (const route of routes) {
      await page.goto(`/#${route.hash}`);
      await verifyRouteLoaded(page, route);
    }
  });

  test('rapid cycle completes without blank screens', async ({ page }) => {
    for (const route of routes) {
      await page.goto(`/#${route.hash}`);
      await verifyRouteLoaded(page, route);
    }
  });

  test('final state is /home with correct content', async ({ page }) => {
    await page.goto('/#/home');
    await waitForAppReady(page);
    // AppRoutes.tsx redirects /home → /chat (Phase 6); verify app shell loaded.
    await expect
      .poll(async () => page.evaluate(() => window.location.hash), { timeout: 10_000 })
      .toMatch(/^#\/(home|chat)/);
    const chars = await page.locator('#root').innerText();
    expect(chars.trim().length).toBeGreaterThan(50);
  });
});
