import debug from 'debug';

import { store } from '../store';
import { notificationReceived } from '../store/notificationSlice';

const log = debug('config-recovery-notice');

/**
 * Stable id so repeated snapshot polls that carry the latched
 * `configRecovered` flag collapse onto a single notification-center row
 * (`notificationReceived` dedupes by id). The once-guard below is the primary
 * defence; this id keeps things idempotent even across it.
 */
const NOTICE_ID = 'config-recovered';

/**
 * One-shot guard: the core latches `configRecovered` for the whole process
 * lifetime, so every `app_state_snapshot` poll (~every few seconds) reports it.
 * Without this guard each poll would re-dispatch the notice, resetting it to
 * unread and re-firing the native banner. Surface it exactly once per app run.
 */
let surfaced = false;

/**
 * Raise a single user-visible notice when the core reports it recovered a
 * corrupted `config.toml` this session (#5167). No-op when `configRecovered`
 * is false/absent or the notice was already shown this run.
 *
 * Rendered in the in-app notification center (System category) and, when the
 * window is unfocused, as an OS banner — the same surface as other
 * core-originated system notices.
 */
export function maybeSurfaceConfigRecovery(configRecovered: boolean | undefined): void {
  if (!configRecovered || surfaced) return;
  surfaced = true;
  log('surfacing config-recovery notice');
  store.dispatch(
    notificationReceived({
      id: NOTICE_ID,
      category: 'system',
      title: 'Settings were reset',
      body: 'Your settings file could not be read and was reset to defaults. The previous file was kept with a ".corrupted" suffix in case you need it.',
      timestamp: Date.now(),
      read: false,
      deepLink: '/settings',
    })
  );
}

/** Test-only: reset the once-guard between runs. */
export function __resetForTests(): void {
  surfaced = false;
}
