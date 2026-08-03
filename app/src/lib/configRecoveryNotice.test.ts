import { beforeEach, describe, expect, it } from 'vitest';

import { store } from '../store';
import { __resetForTests, maybeSurfaceConfigRecovery } from './configRecoveryNotice';

describe('maybeSurfaceConfigRecovery', () => {
  beforeEach(() => {
    __resetForTests();
    store.dispatch({ type: 'notifications/clearAll' });
  });

  it('surfaces a single system notice when config was recovered', () => {
    maybeSurfaceConfigRecovery(true);
    const items = store.getState().notifications.items;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('config-recovered');
    expect(items[0].category).toBe('system');
    expect(items[0].title).toBe('Settings were reset');
    expect(items[0].read).toBe(false);
    expect(items[0].deepLink).toBe('/settings');
  });

  it('is a one-shot — repeated polls do not re-dispatch', () => {
    maybeSurfaceConfigRecovery(true);
    maybeSurfaceConfigRecovery(true);
    maybeSurfaceConfigRecovery(true);
    expect(store.getState().notifications.items).toHaveLength(1);
  });

  it('does nothing when configRecovered is false or absent', () => {
    maybeSurfaceConfigRecovery(false);
    maybeSurfaceConfigRecovery(undefined);
    expect(store.getState().notifications.items).toHaveLength(0);
  });
});
