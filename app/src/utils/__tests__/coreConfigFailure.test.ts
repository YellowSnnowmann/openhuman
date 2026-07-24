import { describe, expect, it } from 'vitest';

import {
  CORE_CONFIG_UNREADABLE_MESSAGE,
  describeCoreConfigFailure,
  isCoreConfigUnreadableError,
} from '../coreConfigFailure';

// The verbatim chain a container core emits when its workspace volume carries a
// config.toml owned by a different uid than the runtime process.
const REPORTED =
  'Failed to read config file: /home/openhuman/.openhuman/config.toml ' +
  '[config owner mismatch] (file uid=0 gid=0 mode=0600; process euid=10001 egid=10001): ' +
  'Permission denied (os error 13)';

describe('isCoreConfigUnreadableError', () => {
  it('matches the reported container failure', () => {
    expect(isCoreConfigUnreadableError(REPORTED)).toBe(true);
  });

  it('matches the pre-ownership-diagnostics shape still shipping in older cores', () => {
    expect(
      isCoreConfigUnreadableError(
        'Failed to read config file: /home/openhuman/.openhuman/config.toml: Permission denied (os error 13)'
      )
    ).toBe(true);
  });

  it('matches the Windows denial and the snapshot-reload context line', () => {
    expect(
      isCoreConfigUnreadableError(
        'Failed to read config file: C:\\Users\\u\\.openhuman\\users\\local\\config.toml: Access is denied. (os error 5)'
      )
    ).toBe(true);
    expect(
      isCoreConfigUnreadableError(
        'reading config.toml from /home/openhuman/.openhuman/config.toml: Permission denied (os error 13)'
      )
    ).toBe(true);
  });

  it('requires BOTH the config-read context and a denial signal', () => {
    // Permission failure from another subsystem keeps its own message.
    expect(isCoreConfigUnreadableError('opening keychain failed: Permission denied')).toBe(false);
    // Config-read failure that is not a denial (missing file, parse) is a
    // different fault with a different remedy.
    expect(
      isCoreConfigUnreadableError(
        'Failed to read config file: /home/openhuman/.openhuman/config.toml: No such file or directory (os error 2)'
      )
    ).toBe(false);
  });

  it('is safe on empty input', () => {
    expect(isCoreConfigUnreadableError(null)).toBe(false);
    expect(isCoreConfigUnreadableError(undefined)).toBe(false);
    expect(isCoreConfigUnreadableError('')).toBe(false);
  });
});

describe('describeCoreConfigFailure', () => {
  it('replaces the raw chain with actionable, path-free copy', () => {
    const described = describeCoreConfigFailure(REPORTED);
    expect(described).toBe(CORE_CONFIG_UNREADABLE_MESSAGE);
    // The person reading the sign-in screen cannot act on a container path, a
    // uid, or an errno — and the path is the runtime host's, not theirs.
    expect(described).not.toMatch(/\/home\/openhuman|os error|uid=/);
  });

  it('returns null for unrelated failures so they keep their own message', () => {
    expect(describeCoreConfigFailure('token save failed')).toBeNull();
  });
});
