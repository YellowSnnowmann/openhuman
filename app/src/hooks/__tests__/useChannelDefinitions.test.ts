import { describe, expect, it } from 'vitest';

import type { ChannelStatusEntry } from '../../types/channels';
import { resolveStatusPatch } from '../useChannelDefinitions';

function entry(overrides: Partial<ChannelStatusEntry>): ChannelStatusEntry {
  return {
    channel_id: 'discord',
    auth_mode: 'bot_token',
    connected: false,
    has_credentials: true,
    ...overrides,
  };
}

describe('resolveStatusPatch (issue #3712)', () => {
  it('asserts connected and clears any prior error', () => {
    expect(resolveStatusPatch(entry({ connected: true, error: 'stale' }), 'error')).toEqual({
      status: 'connected',
      lastError: undefined,
    });
  });

  it('surfaces a live listener error with its reason', () => {
    expect(
      resolveStatusPatch(entry({ connected: false, error: 'gateway closed (4004)' }), 'connected')
    ).toEqual({ status: 'error', lastError: 'gateway closed (4004)' });
  });

  it('does not stomp an in-flight connect when not-connected with no error', () => {
    expect(resolveStatusPatch(entry({ connected: false }), 'connecting')).toBeNull();
  });

  it('downgrades a stale connected entry to disconnected', () => {
    expect(resolveStatusPatch(entry({ connected: false }), 'connected')).toEqual({
      status: 'disconnected',
      lastError: undefined,
    });
  });

  it('reports disconnected when there is no prior status', () => {
    expect(resolveStatusPatch(entry({ connected: false }), undefined)).toEqual({
      status: 'disconnected',
      lastError: undefined,
    });
  });
});
