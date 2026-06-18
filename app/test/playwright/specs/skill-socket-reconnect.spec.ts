import { expect, test } from '@playwright/test';

import {
  bootAuthenticatedPage,
  dismissWalkthroughIfPresent,
  waitForAppReady,
} from '../helpers/core-rpc';

test.describe('Socket reconnect skill sync smoke', () => {
  test('reaches Home after login as baseline for post-reconnect flows', async ({ page }) => {
    await bootAuthenticatedPage(page, 'pw-skill-socket-reconnect', '/home');
    await waitForAppReady(page);
    await dismissWalkthroughIfPresent(page);
    // /home redirects to /chat (Phase 6); verify app shell loaded (not welcome screen).
    await expect
      .poll(async () => page.evaluate(() => window.location.hash), { timeout: 10_000 })
      .toMatch(/^#\/(home|chat)/);
  });
});
