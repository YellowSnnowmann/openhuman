import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../../test/test-utils';
import AppSidebar from './AppSidebar';

const mockNavigate = vi.fn();
const mockTrackEvent = vi.fn();
// Mutable so each test can pick the session kind. Must be `mock`-prefixed so the
// hoisted vi.mock factory below is allowed to close over it.
let mockSessionToken: string | null = 'cloud.session.token';

vi.mock('react-router-dom', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});
// Render i18n keys verbatim so assertions don't depend on locale copy.
vi.mock('../../../lib/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }));
vi.mock('../../../services/analytics', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));
vi.mock('../../../providers/CoreStateProvider', () => ({
  useCoreState: () => ({ snapshot: { sessionToken: mockSessionToken } }),
}));
// Keep the mount light: the footer affordance rows are the unit under test, not
// the header/nav/rail children (SidebarHeader in particular needs the
// RootShellLayout context the test harness doesn't provide). SidebarSlot is left
// real on purpose — the harness itself imports SidebarSlotProvider from it.
vi.mock('./SidebarHeader', () => ({ default: () => null }));
vi.mock('./SidebarNav', () => ({ default: () => null }));
vi.mock('./SidebarAppRail', () => ({ default: () => null }));
vi.mock('../../ConnectionIndicator', () => ({ default: () => null }));

describe('AppSidebar — Rewards footer entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionToken = 'cloud.session.token';
  });

  it('shows the Rewards row for a cloud session and navigates + tracks on click', () => {
    renderWithProviders(<AppSidebar />, { initialEntries: ['/chat'] });

    const rewards = screen.getByTitle('nav.rewards');
    expect(rewards).toBeInTheDocument();

    fireEvent.click(rewards);

    expect(mockNavigate).toHaveBeenCalledWith('/rewards');
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'tab_bar_change',
      expect.objectContaining({ to_tab: 'rewards', to_path: '/rewards' })
    );
  });

  it('hides the Rewards row for a local session but keeps Feedback', () => {
    mockSessionToken = 'header.payload.local';
    renderWithProviders(<AppSidebar />, { initialEntries: ['/chat'] });

    expect(screen.queryByTitle('nav.rewards')).not.toBeInTheDocument();
    expect(screen.getByTitle('nav.feedback')).toBeInTheDocument();
  });

  it('marks the Rewards row active on the /rewards route', () => {
    renderWithProviders(<AppSidebar />, { initialEntries: ['/rewards'] });

    expect(screen.getByTitle('nav.rewards')).toHaveAttribute('aria-current', 'page');
  });
});
