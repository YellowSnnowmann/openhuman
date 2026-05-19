// @ts-nocheck
/**
 * User journey — settings round-trip.
 *
 * Verifies that a user can navigate to every major settings sub-panel
 * and return home without encountering blank screens or error states.
 *
 * Journey:
 *   1. Login + land on home
 *   2. /settings/account         — verify loads
 *   3. /settings/data            — verify loads
 *   4. /settings/advanced        — verify loads
 *   5. /settings/billing         — verify billing panel loads
 *   6. /home                     — verify home loads
 *   7. /chat                     — verify chat loads
 *
 * Each screen must load within 10s with non-trivial content (no blank/error state).
 */
import { waitForApp, waitForAppReady } from '../helpers/app-helpers';
import { textExists } from '../helpers/element-helpers';
import { resetApp } from '../helpers/reset-app';
import {
  navigateToBilling,
  navigateToHome,
  navigateViaHash,
  waitForHomePage,
} from '../helpers/shared-flows';
import { startMockServer, stopMockServer } from '../mock-server';

const LOG_PREFIX = '[user-journey-settings-round-trip]';
const USER_ID = 'e2e-user-journey-settings-round-trip';
const PANEL_TIMEOUT = 10_000;

async function rootTextLength(): Promise<number> {
  return (await browser.execute(
    () => (document.getElementById('root')?.innerText ?? '').length
  )) as number;
}

async function waitForPanelLoad(
  panelDescription: string,
  timeout: number = PANEL_TIMEOUT
): Promise<void> {
  await waitForAppReady(timeout);
  const chars = await rootTextLength();
  if (chars < 50) {
    throw new Error(`${panelDescription}: panel appears blank (${chars} chars in #root)`);
  }
  console.log(`${LOG_PREFIX} ${panelDescription}: loaded (${chars} chars)`);
}

describe('User journey — settings round-trip', () => {
  before(async () => {
    console.log(`${LOG_PREFIX} Starting mock server and resetting app`);
    await startMockServer();
    await waitForApp();
    await resetApp(USER_ID);
    console.log(`${LOG_PREFIX} Setup complete`);
  });

  after(async () => {
    await stopMockServer();
    console.log(`${LOG_PREFIX} Teardown complete`);
  });

  it('starts on /home after login', async () => {
    console.log(`${LOG_PREFIX} Verifying home page is accessible`);
    await waitForAppReady(PANEL_TIMEOUT);
    const homeText = await waitForHomePage(PANEL_TIMEOUT);
    expect(homeText).toBeTruthy();
    console.log(`${LOG_PREFIX} Home confirmed: "${homeText}"`);
  });

  it('/settings/account — loads within 10s', async () => {
    console.log(`${LOG_PREFIX} Navigating to /settings/account`);
    await navigateViaHash('/settings/account');
    await waitForPanelLoad('/settings/account');

    // Look for account-related content (name, email, profile, account, settings).
    const accountMarkers = ['Account', 'account', 'Profile', 'Name', 'Email', 'Settings'];
    let found = false;
    for (const marker of accountMarkers) {
      if (await textExists(marker)) {
        console.log(`${LOG_PREFIX} /settings/account: found marker "${marker}"`);
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('/settings/data — loads within 10s', async () => {
    console.log(`${LOG_PREFIX} Navigating to /settings/data`);
    await navigateViaHash('/settings/data');
    await waitForPanelLoad('/settings/data');

    const dataMarkers = ['Data', 'data', 'Storage', 'Memory', 'Export', 'Import', 'Settings'];
    let found = false;
    for (const marker of dataMarkers) {
      if (await textExists(marker)) {
        console.log(`${LOG_PREFIX} /settings/data: found marker "${marker}"`);
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('/settings/advanced — loads within 10s', async () => {
    console.log(`${LOG_PREFIX} Navigating to /settings/advanced`);
    await navigateViaHash('/settings/advanced');
    await waitForPanelLoad('/settings/advanced');

    const advancedMarkers = ['Advanced', 'advanced', 'Developer', 'Debug', 'Settings', 'Logs'];
    let found = false;
    for (const marker of advancedMarkers) {
      if (await textExists(marker)) {
        console.log(`${LOG_PREFIX} /settings/advanced: found marker "${marker}"`);
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('/settings/billing — billing panel loads within 15s', async () => {
    console.log(`${LOG_PREFIX} Navigating to /settings/billing`);
    // navigateToBilling includes its own content verification.
    await navigateToBilling();
    console.log(`${LOG_PREFIX} /settings/billing: loaded`);
  });

  it('/home — loads after settings round-trip', async () => {
    console.log(`${LOG_PREFIX} Navigating back to /home`);
    await navigateToHome();
    const homeText = await waitForHomePage(PANEL_TIMEOUT);
    expect(homeText).toBeTruthy();
    console.log(`${LOG_PREFIX} /home: loaded — "${homeText}"`);
  });

  it('/chat — loads within 10s', async () => {
    console.log(`${LOG_PREFIX} Navigating to /chat`);
    await navigateViaHash('/chat');
    await waitForPanelLoad('/chat');

    const chatMarkers = ['Threads', 'Chat', 'Message', 'New thread', 'conversation'];
    let found = false;
    for (const marker of chatMarkers) {
      if (await textExists(marker)) {
        console.log(`${LOG_PREFIX} /chat: found marker "${marker}"`);
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
    console.log(`${LOG_PREFIX} /chat: loaded`);
  });
});
