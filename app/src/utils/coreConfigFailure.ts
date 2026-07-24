/**
 * Recognise the one core failure that reads like a transient sign-in glitch but
 * is a permanent, environment-level fault: the core cannot open its own
 * `config.toml`.
 *
 * The Rust chain looks like
 *   `Failed to read config file: /home/openhuman/.openhuman/config.toml
 *    [config owner mismatch] (file uid=0 …): Permission denied (os error 13)`
 * and, before this module existed, was painted verbatim into the Welcome
 * screen (absolute path included) with no classification and no recovery hint,
 * while the OAuth path bucketed it as `'other'` → "Sign-in failed. Please try
 * again." — presenting a permanent fault as a retryable one.
 *
 * Every config-dependent RPC fails the same way, so no amount of retrying
 * helps; the fix is always on the runtime host.
 */

/** Context lines the Rust loader wraps a config read in. */
const CONFIG_READ_ANCHOR = /failed to read config file|reading config\.toml from/;

/** OS denial signals, unix and Windows. */
const PERMISSION_SIGNAL = /permission denied|access is denied|os error 13|os error 5/;

/** Marker the core appends when the file's uid differs from the process euid. */
const OWNER_MISMATCH_MARKER = 'config owner mismatch';

/**
 * True when `message` is a core config-read denial rather than an unrelated
 * permission error. Requires BOTH the config-read context and a denial signal
 * so a permission failure from any other subsystem keeps its own message.
 */
export const isCoreConfigUnreadableError = (message: string | null | undefined): boolean => {
  const lowered = (message ?? '').toLowerCase();
  if (!CONFIG_READ_ANCHOR.test(lowered)) {
    return false;
  }
  return PERMISSION_SIGNAL.test(lowered) || lowered.includes(OWNER_MISMATCH_MARKER);
};

/**
 * User-facing copy for a config-read denial. Deliberately carries no
 * filesystem path, uid, or errno — those live in the runtime's own log, which
 * is where the person who can fix this is looking.
 */
export const CORE_CONFIG_UNREADABLE_MESSAGE =
  'The runtime could not read its configuration file — config.toml is owned by a ' +
  'different user account than the runtime process. Restart the runtime; if that ' +
  "does not help, repair the workspace directory's ownership or re-create its volume.";

/**
 * Friendly replacement for a raw core error, or `null` when the message is not
 * a config-read denial and should be surfaced as-is.
 */
export const describeCoreConfigFailure = (message: string | null | undefined): string | null =>
  isCoreConfigUnreadableError(message) ? CORE_CONFIG_UNREADABLE_MESSAGE : null;
