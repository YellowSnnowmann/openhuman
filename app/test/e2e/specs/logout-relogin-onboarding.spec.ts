// @ts-nocheck
/**
 * E2E regression: onboarding overlay after logout -> re-login.
 *
 * Verifies:
 *   1. Initial login can complete onboarding and reach Home.
 *   2. Logout returns to the Welcome screen (session is cleared).
 *   3. Re-login triggers the auth deep-link flow (token exchange via
 *      /telegram/login-tokens/ + /auth/me profile fetch).
 *   4. After re-login, the auth exchange and /auth/me refresh complete, then
 *      the routed onboarding flow appears at its first step. This confirms the
 *      fresh session does not carry stale mid-flow onboarding state from the
 *      previous session.
 *
 * Architecture note: auth tokens live in the Rust core (not Redux-persist).
 * `applySessionToken` stores the JWT and fires `core-state:session-token-updated`
 * immediately after the token exchange, then CoreStateProvider refreshes the
 * authoritative user/profile snapshot. Routing now waits for that refreshed
 * currentUser before sending incomplete onboarding sessions to /onboarding, so
 * this spec verifies the backend calls first, then the UI route.
 */
import { waitForApp, waitForAppReady, waitForAuthBootstrap } from '../helpers/app-helpers';
import { callOpenhumanRpc } from '../helpers/core-rpc';
import { triggerAuthDeepLink } from '../helpers/deep-link-helpers';
import {
  hasAppChrome,
  textExists,
  waitForWebView,
  waitForWindowVisible,
} from '../helpers/element-helpers';
import { resetApp } from '../helpers/reset-app';
import {
  dismissBootCheckGateIfVisible,
  logoutViaSettings,
  performFullLogin,
  waitForOnboardingOverlayVisible,
  waitForRequest,
} from '../helpers/shared-flows';
import {
  clearRequestLog,
  getRequestLog,
  resetMockBehavior,
  setMockBehavior,
  startMockServer,
  stopMockServer,
} from '../mock-server';

describe('Logout -> re-login onboarding overlay', () => {
  before(async () => {
    await startMockServer();
    await waitForApp();
    // Reach Welcome screen first (this spec drives login itself).
    await resetApp('e2e-logout-relogin-reset', { skipAuth: true });
    clearRequestLog();
    resetMockBehavior();
  });

  after(async () => {
    resetMockBehavior();
    await stopMockServer();
  });

  it('shows onboarding overlay with clean state after logout and re-login', async function () {
    this.timeout(120_000);
    const hasChrome = await hasAppChrome();
    expect(hasChrome).toBe(true);

    // ── First login: complete onboarding and reach Home ──────────────────────
    clearRequestLog();
    resetMockBehavior();
    await performFullLogin('e2e-logout-relogin-first-token', '[LogoutReLogin]');

    // Let post-onboarding routing guards settle before navigating to Settings.
    await browser.pause(3_000);

    // ── Logout ────────────────────────────────────────────────────────────────
    await logoutViaSettings('[LogoutReLogin]');
    // logoutViaSettings confirms "Welcome" is visible — the session is cleared.

    // Reset core state (onboarding_completed, chat_onboarding_completed, api_key)
    // so the re-login is treated as a fresh user session. Without this,
    // the Rust core retains onboarding_completed=true from the first session
    // and the overlay would not reappear for the same mock user.
    const resetResult = await Promise.race([
      callOpenhumanRpc('openhuman.test_reset', {}),
      new Promise(resolve => setTimeout(() => resolve({ ok: false, error: 'timeout' }), 8_000)),
    ]);
    if (!resetResult.ok) {
      console.log('[LogoutReLogin] test_reset result:', JSON.stringify(resetResult));
    }

    // Reload the renderer so the CoreStateProvider picks up the fresh
    // onboarding_completed=false from the Rust core. Without this the
    // stale snapshot keeps onboarding_completed=true and the routing
    // guard never redirects to /onboarding.
    // NOTE: Do NOT clear localStorage here — that destroys the persisted
    // core mode and causes the BootCheckGate to block the entire app.
    await browser.execute(() => {
      window.location.replace('#/');
      window.location.reload();
    });
    await browser.pause(2_000);

    // The reload may surface the BootCheckGate if the core mode was lost
    // during logout. Dismiss it so the auth flow can proceed.
    await waitForWindowVisible(15_000);
    await waitForWebView(10_000);
    await dismissBootCheckGateIfVisible(12_000);
    await browser.pause(1_000);

    // ── Second login (re-login) ───────────────────────────────────────────────
    // Add a profile-fetch delay to exercise the path where /auth/me is slow.
    // The token exchange (`POST /telegram/login-tokens/`) still completes
    // immediately; the delay only slows the /auth/me confirmation call.
    setMockBehavior('telegramMeDelayMs', '3000');
    clearRequestLog();

    await triggerAuthDeepLink('e2e-logout-relogin-second-token');
    await waitForWindowVisible(25_000);
    await waitForWebView(15_000);
    await waitForAppReady(15_000);
    await waitForAuthBootstrap(15_000);

    // Confirm the deep-link was processed: app exchanged the raw Telegram token
    // for a session JWT via the consume endpoint.
    const consumeCall = await waitForRequest(
      getRequestLog,
      'POST',
      '/telegram/login-tokens/',
      20_000
    );
    if (!consumeCall) {
      console.log(
        '[LogoutReLogin] Missing consume call on re-login. Request log:',
        JSON.stringify(getRequestLog(), null, 2)
      );
    }
    expect(consumeCall).toBeDefined();

    // ── /auth/me must have been called for the new session ───────────────────
    // Routing to /onboarding is intentionally held until the core snapshot has
    // a real currentUser. Waiting for the backend validation first prevents the
    // logged-out Welcome screen from being mistaken for onboarding while
    // telegramMeDelayMs is active.
    const meCall = await waitForRequest(getRequestLog, 'GET', '/auth/me', 20_000);
    expect(meCall).toBeDefined();

    // ── Onboarding must appear for the fresh session ─────────────────────────
    // The new user has not completed onboarding, so the routed onboarding shell
    // should mount once the profile-backed core snapshot is available.
    // Allow extra time for the profile refresh (telegramMeDelayMs=3000) and
    // subsequent routing to settle. The sequence: deep-link → token exchange
    // → /auth/me (3s delay) → core snapshot → routing guard → onboarding
    // mount can take 20-40s on slower machines.
    const overlayVisible = await waitForOnboardingOverlayVisible(40_000);
    if (!overlayVisible) {
      console.log(
        '[LogoutReLogin] Overlay did not appear after timeout. Request log:',
        JSON.stringify(getRequestLog(), null, 2)
      );
    }
    expect(overlayVisible).toBe(true);

    const route = await browser.execute(() => window.location.hash);
    expect(route).toMatch(/^#\/onboarding/);

    // ── Onboarding must be in clean first-step state ─────────────────────────
    // If stale mid-flow state from session 1 leaked, a later step would render
    // instead of the initial welcome step.
    const onFirstStep = await browser.execute(
      () => document.querySelector('[data-testid="onboarding-welcome-step"]') !== null
    );
    expect(onFirstStep).toBe(true);
    expect(await textExists("Hi. I'm OpenHuman.")).toBe(true);
    expect(await textExists('Get Started')).toBe(true);
  });
});
