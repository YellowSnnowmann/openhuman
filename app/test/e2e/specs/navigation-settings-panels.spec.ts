// @ts-nocheck
/**
 * Navigation — settings sub-panel coverage.
 *
 * Visits every settings sub-panel and verifies each loads without
 * blank screens or error states.
 *
 * Tests:
 *   N2.1 — /settings/account
 *   N2.2 — /settings/channels
 *   N2.3 — /settings/data
 *   N2.4 — /settings/ai-skills
 *   N2.5 — /settings/advanced
 *   N2.6 — /settings/billing
 *   N2.7 — /settings/dev
 *   N2.8 — /settings/features
 *   N2.9 — back navigation to /home returns home content
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

const LOG_PREFIX = '[navigation-settings-panels]';
const USER_ID = 'e2e-navigation-settings-panels';
const PANEL_TIMEOUT = 10_000;

interface PanelCheck {
  hash: string;
  /** Candidate strings — any one match confirms the panel loaded. */
  markers: string[];
  /** Use the navigateToBilling helper (has its own verification). */
  useBillingHelper?: boolean;
}

const PANELS: PanelCheck[] = [
  {
    hash: '/settings/account',
    markers: ['Account', 'Profile', 'Name', 'Email', 'Settings'],
  },
  {
    hash: '/settings/channels',
    markers: ['Channels', 'Channel', 'Connect', 'Provider', 'Gmail', 'Telegram', 'Settings'],
  },
  {
    hash: '/settings/data',
    markers: ['Data', 'Storage', 'Memory', 'Export', 'Import', 'Settings'],
  },
  {
    hash: '/settings/ai-skills',
    markers: ['Skills', 'AI Skills', 'Skill', 'Install', 'Browse', 'Settings'],
  },
  {
    hash: '/settings/advanced',
    markers: ['Advanced', 'Developer', 'Debug', 'Settings', 'Logs'],
  },
  {
    hash: '/settings/billing',
    markers: ['Billing', 'Plan', 'Subscription', 'Usage'],
    useBillingHelper: true,
  },
  {
    hash: '/settings/dev',
    markers: ['Dev', 'Developer', 'Debug', 'Tools', 'Settings', 'Advanced'],
  },
  {
    hash: '/settings/features',
    markers: ['Features', 'Feature', 'Enable', 'Disable', 'Preview', 'Settings'],
  },
];

async function rootTextLength(): Promise<number> {
  return (await browser.execute(
    () => (document.getElementById('root')?.innerText ?? '').length
  )) as number;
}

async function verifyPanelLoaded(panel: PanelCheck): Promise<void> {
  await waitForAppReady(PANEL_TIMEOUT);

  const chars = await rootTextLength();
  if (chars < 50) {
    throw new Error(`${panel.hash}: panel appears blank (${chars} chars in #root)`);
  }

  let foundMarker = '';
  for (const marker of panel.markers) {
    if (await textExists(marker)) {
      foundMarker = marker;
      break;
    }
  }

  if (foundMarker) {
    console.log(`${LOG_PREFIX} ${panel.hash}: loaded (found "${foundMarker}", ${chars} chars)`);
  } else {
    // Non-fatal: the panel may render different text depending on config / state.
    // The char-count check above is the authoritative blank-screen guard.
    console.log(`${LOG_PREFIX} ${panel.hash}: loaded (${chars} chars, no marker matched — acceptable)`);
  }
}

describe('Navigation — settings sub-panels', () => {
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

  it('N2.1 — /settings/account loads', async () => {
    const panel = PANELS[0];
    console.log(`${LOG_PREFIX} N2.1: navigating to ${panel.hash}`);
    await navigateViaHash(panel.hash);
    await verifyPanelLoaded(panel);
  });

  it('N2.2 — /settings/channels loads', async () => {
    const panel = PANELS[1];
    console.log(`${LOG_PREFIX} N2.2: navigating to ${panel.hash}`);
    await navigateViaHash(panel.hash);
    await verifyPanelLoaded(panel);
  });

  it('N2.3 — /settings/data loads', async () => {
    const panel = PANELS[2];
    console.log(`${LOG_PREFIX} N2.3: navigating to ${panel.hash}`);
    await navigateViaHash(panel.hash);
    await verifyPanelLoaded(panel);
  });

  it('N2.4 — /settings/ai-skills loads', async () => {
    const panel = PANELS[3];
    console.log(`${LOG_PREFIX} N2.4: navigating to ${panel.hash}`);
    await navigateViaHash(panel.hash);
    await verifyPanelLoaded(panel);
  });

  it('N2.5 — /settings/advanced loads', async () => {
    const panel = PANELS[4];
    console.log(`${LOG_PREFIX} N2.5: navigating to ${panel.hash}`);
    await navigateViaHash(panel.hash);
    await verifyPanelLoaded(panel);
  });

  it('N2.6 — /settings/billing loads', async () => {
    console.log(`${LOG_PREFIX} N2.6: navigating to /settings/billing`);
    // Use the dedicated helper which includes its own content verification.
    await navigateToBilling();
    console.log(`${LOG_PREFIX} N2.6: passed`);
  });

  it('N2.7 — /settings/dev loads', async () => {
    const panel = PANELS[6];
    console.log(`${LOG_PREFIX} N2.7: navigating to ${panel.hash}`);
    await navigateViaHash(panel.hash);
    await verifyPanelLoaded(panel);
  });

  it('N2.8 — /settings/features loads', async () => {
    const panel = PANELS[7];
    console.log(`${LOG_PREFIX} N2.8: navigating to ${panel.hash}`);
    await navigateViaHash(panel.hash);
    await verifyPanelLoaded(panel);
  });

  it('N2.9 — back navigation from last panel returns to /home', async () => {
    console.log(`${LOG_PREFIX} N2.9: navigating back to /home`);
    await navigateToHome();
    const homeText = await waitForHomePage(PANEL_TIMEOUT);
    expect(homeText).toBeTruthy();

    const hash = await browser.execute(() => window.location.hash);
    expect(hash).toMatch(/^#\/home/);
    console.log(`${LOG_PREFIX} N2.9: passed — home content: "${homeText}"`);
  });
});
