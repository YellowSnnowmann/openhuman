import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import * as recallCalendarApi from './recallCalendarApi';
import { openhumanUpdateMeetSettings } from '../../utils/tauriCommands/config';
import { useRecallCalendar } from './hooks';

vi.mock('../../utils/tauriCommands/config', () => ({ openhumanUpdateMeetSettings: vi.fn() }));

vi.mock('../../utils/openUrl', () => ({ openUrl: vi.fn() }));

vi.mock('./recallCalendarApi', () => ({ status: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }));

describe('useRecallCalendar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(openhumanUpdateMeetSettings).mockResolvedValue({
      result: { config: {}, workspace_dir: '/tmp', config_path: '/tmp/config.toml' },
      logs: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('syncs Recall as provider when initial status is already connected', async () => {
    vi.mocked(recallCalendarApi.status).mockResolvedValue({
      enabled: true,
      connected: true,
      email: 'user@example.com',
    });

    renderHook(() => useRecallCalendar());

    await waitFor(() => {
      expect(openhumanUpdateMeetSettings).toHaveBeenCalledWith({ calendar_provider: 'recall' });
    });
  });
});
