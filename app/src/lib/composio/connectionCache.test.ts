import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearConnectionCache, readConnectionCache, writeConnectionCache } from './connectionCache';
import type { ComposioConnection, ComposioToolkitCatalogEntry } from './types';

const ACTIVE_USER_KEY = 'OPENHUMAN_ACTIVE_USER_ID';

const conn = (toolkit: string, status = 'ACTIVE'): ComposioConnection => ({
  id: `c-${toolkit}`,
  toolkit,
  status,
});
const cat = (slug: string): ComposioToolkitCatalogEntry => ({ slug, name: slug });

describe('connectionCache', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // The module keeps an in-memory mirror; clear it between tests by evicting
    // for whatever user id a prior test may have left active.
    clearConnectionCache();
    window.localStorage.setItem(ACTIVE_USER_KEY, 'user-a');
    clearConnectionCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it('returns null when nothing is cached', () => {
    expect(readConnectionCache()).toBeNull();
  });

  it('round-trips a written snapshot', () => {
    writeConnectionCache({
      connections: [conn('gmail'), conn('notion')],
      toolkits: ['gmail', 'notion'],
      catalog: [cat('gmail'), cat('notion')],
    });

    const got = readConnectionCache();
    expect(got?.connections.map(c => c.toolkit)).toEqual(['gmail', 'notion']);
    expect(got?.toolkits).toEqual(['gmail', 'notion']);
    expect(got?.catalog.map(c => c.slug)).toEqual(['gmail', 'notion']);
  });

  it('merges a connections-only patch without clobbering toolkit/catalog', () => {
    writeConnectionCache({
      connections: [conn('gmail')],
      toolkits: ['gmail', 'github'],
      catalog: [cat('gmail'), cat('github')],
    });

    // Poll-style refresh: only connections supplied.
    writeConnectionCache({ connections: [conn('gmail'), conn('github')] });

    const got = readConnectionCache();
    expect(got?.connections.map(c => c.toolkit)).toEqual(['gmail', 'github']);
    // Toolkit allowlist + catalog survive the partial write.
    expect(got?.toolkits).toEqual(['gmail', 'github']);
    expect(got?.catalog.map(c => c.slug)).toEqual(['gmail', 'github']);
  });

  it('clears the cached snapshot', () => {
    writeConnectionCache({ connections: [conn('gmail')] });
    expect(readConnectionCache()).not.toBeNull();

    clearConnectionCache();
    expect(readConnectionCache()).toBeNull();
  });

  it('expires snapshots older than the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    writeConnectionCache({ connections: [conn('gmail')] });
    expect(readConnectionCache()).not.toBeNull();

    // Advance just past the 24h TTL; the in-memory mirror must also respect it.
    vi.setSystemTime(new Date('2026-01-02T00:00:01Z'));
    expect(readConnectionCache()).toBeNull();
  });

  it('namespaces the cache per active user', () => {
    writeConnectionCache({ connections: [conn('gmail')] });
    expect(readConnectionCache()?.connections).toHaveLength(1);

    // Identity flip to user-b — must not see user-a's connections.
    window.localStorage.setItem(ACTIVE_USER_KEY, 'user-b');
    expect(readConnectionCache()).toBeNull();

    writeConnectionCache({ connections: [conn('slack'), conn('github')] });
    expect(readConnectionCache()?.connections.map(c => c.toolkit)).toEqual(['slack', 'github']);

    // Flipping back to user-a restores their original snapshot from disk.
    window.localStorage.setItem(ACTIVE_USER_KEY, 'user-a');
    expect(readConnectionCache()?.connections.map(c => c.toolkit)).toEqual(['gmail']);
  });

  it('returns null on malformed persisted JSON', () => {
    window.localStorage.setItem('composio:connections:v1:user-a', '{ not json');
    expect(readConnectionCache()).toBeNull();
  });

  it('returns null when the persisted shape is invalid', () => {
    window.localStorage.setItem(
      'composio:connections:v1:user-a',
      JSON.stringify({ fetchedAt: Date.now(), connections: 'nope' })
    );
    expect(readConnectionCache()).toBeNull();
  });
});
