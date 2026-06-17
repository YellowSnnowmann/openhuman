import { afterEach, describe, expect, it, vi } from 'vitest';

import { setOAuthReturnRoute, takeOAuthReturnRoute } from '../oauthReturnRoute';

const STORAGE_KEY = 'openhuman:oauth:return-route';

describe('oauthReturnRoute', () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('stores a route and returns it once, clearing it afterwards', () => {
    setOAuthReturnRoute('/rewards');
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('/rewards');

    expect(takeOAuthReturnRoute()).toBe('/rewards');
    // Cleared after read → falls back to the default on the next call.
    expect(takeOAuthReturnRoute()).toBe('/connections');
  });

  it('defaults to /connections when nothing is stored', () => {
    expect(takeOAuthReturnRoute()).toBe('/connections');
  });

  it('ignores a stored value that is not an in-app path', () => {
    sessionStorage.setItem(STORAGE_KEY, 'https://evil.example.com');
    expect(takeOAuthReturnRoute()).toBe('/connections');
  });

  it('falls back to the default when sessionStorage write throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    // Must not throw.
    expect(() => setOAuthReturnRoute('/rewards')).not.toThrow();
  });

  it('falls back to the default when sessionStorage read throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    expect(takeOAuthReturnRoute()).toBe('/connections');
  });
});
