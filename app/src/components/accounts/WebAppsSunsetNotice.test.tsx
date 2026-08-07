import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import WebAppsSunsetNotice from './WebAppsSunsetNotice';

let mockState = { accounts: { order: [] as string[] } };

vi.mock('../../lib/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }));
vi.mock('../../store/hooks', () => ({
  useAppSelector: (sel: (state: typeof mockState) => unknown) => sel(mockState),
}));

describe('WebAppsSunsetNotice', () => {
  beforeEach(() => {
    mockState = { accounts: { order: [] } };
  });

  it('renders nothing when the user has no connected web apps (#5423)', () => {
    mockState = { accounts: { order: [] } };
    render(<WebAppsSunsetNotice />);

    // A user who never connected an app must see no trace of the feature.
    expect(screen.queryByTestId('web-apps-sunset-notice')).toBeNull();
  });

  it('shows the removal notice when the user has connected web apps (#5423)', () => {
    mockState = { accounts: { order: ['acct-whatsapp'] } };
    render(<WebAppsSunsetNotice />);

    expect(screen.getByTestId('web-apps-sunset-notice')).toBeInTheDocument();
    expect(screen.getByText('webAppsSunset.title')).toBeInTheDocument();
    expect(screen.getByText('webAppsSunset.message')).toBeInTheDocument();
  });

  it('is not dismissible — no dismiss control is rendered (#5423)', () => {
    mockState = { accounts: { order: ['acct-whatsapp'] } };
    render(<WebAppsSunsetNotice />);

    // The deadline is fixed, so the notice must stay put rather than be silenced.
    expect(screen.queryByRole('button', { name: 'common.dismiss' })).toBeNull();
  });
});
