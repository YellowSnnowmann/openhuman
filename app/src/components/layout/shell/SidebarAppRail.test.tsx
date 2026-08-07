import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { purgeWebviewAccount } from '../../../services/webviewAccountService';
import SidebarAppRail from './SidebarAppRail';

const mockNavigate = vi.fn();
const mockDispatch = vi.fn();

const whatsappAccount = {
  id: 'acct-whatsapp',
  provider: 'whatsapp',
  label: 'WhatsApp',
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'open',
};

const accountsWith: Record<string, typeof whatsappAccount> = { 'acct-whatsapp': whatsappAccount };

let mockState = {
  accounts: {
    accounts: accountsWith,
    order: ['acct-whatsapp'],
    activeAccountId: null as string | null,
    unread: {} as Record<string, number>,
  },
};

function setAccounts(order: string[]) {
  mockState = {
    accounts: {
      accounts: order.length ? accountsWith : {},
      order,
      activeAccountId: null,
      unread: {},
    },
  };
}

vi.mock('react-router-dom', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../../lib/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }));
vi.mock('../../../services/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../../services/webviewAccountService', () => ({ purgeWebviewAccount: vi.fn() }));
vi.mock('../../../store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (sel: (state: typeof mockState) => unknown) => sel(mockState),
}));

describe('SidebarAppRail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAccounts(['acct-whatsapp']);
  });

  it('selects a provider webview without mutating the current route', () => {
    renderRail('/chat/thread-1');

    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp' }));

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'accounts/setActiveAccount',
      payload: 'acct-whatsapp',
    });
  });

  it('does not navigate again when selecting the agent from a thread route', () => {
    renderRail('/chat/thread-1');

    fireEvent.click(screen.getByRole('button', { name: 'accounts.agent' }));

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'accounts/setActiveAccount',
      payload: '__agent__',
    });
  });

  it('offers no way to add a new app — the feature is being removed (#5423)', () => {
    setAccounts(['acct-whatsapp']);
    renderRail('/chat');

    // The "Add apps" button and its label are gone: a user can no longer pick
    // up a service they were not already using.
    expect(screen.queryByTestId('accounts-add-button')).toBeNull();
    expect(screen.queryByText('accounts.addApps')).toBeNull();
  });

  it('shows only the agent tile when no apps are connected — no trace of the feature (#5423)', () => {
    setAccounts([]);
    renderRail('/chat');

    // The agent tile is core chat and stays; there are no provider tiles and no
    // add affordance, so a user who never connected an app sees nothing of it.
    expect(screen.getByRole('button', { name: 'accounts.agent' })).toBeInTheDocument();
    expect(screen.queryByTestId('accounts-add-button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'WhatsApp' })).toBeNull();
  });

  it('still lets a connected app be reconnected by selecting its tile (#5423)', () => {
    setAccounts(['acct-whatsapp']);
    renderRail('/chat');

    // Selecting an already-connected app re-activates it (reconnect path), which
    // must keep working after the add path is removed.
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp' }));
    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'accounts/setActiveAccount',
      payload: 'acct-whatsapp',
    });
  });

  it('drops the account from state synchronously on disconnect, before the async purge (#4695)', () => {
    setAccounts(['acct-whatsapp']);
    // Hold the purge pending so we can prove `removeAccount` was dispatched
    // *before* the purge (which triggers the app re-mount) resolves. The old
    // order (await purge → removeAccount) let the re-mount re-open the
    // just-purged webview because the account was still in the store.
    let resolvePurge: () => void = () => {};
    vi.mocked(purgeWebviewAccount).mockReturnValue(
      new Promise<void>(res => {
        resolvePurge = res;
      })
    );

    renderRail('/chat');

    fireEvent.contextMenu(screen.getByRole('button', { name: 'WhatsApp' }));
    fireEvent.click(screen.getByText('accounts.disconnect'));

    // removeAccount is dispatched while the purge is still pending.
    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'accounts/removeAccount',
      payload: { accountId: 'acct-whatsapp' },
    });
    expect(purgeWebviewAccount).toHaveBeenCalledWith('acct-whatsapp');

    resolvePurge();
  });

  it('still drops the account and swallows the error when the purge rejects (#4695)', async () => {
    setAccounts(['acct-whatsapp']);
    // A purge failure must not leave the user with a zombie icon: the account is
    // already removed from state before the await, and the rejection is caught
    // and logged (not surfaced) so the disconnect handler resolves cleanly.
    vi.mocked(purgeWebviewAccount).mockRejectedValue(new Error('purge failed'));

    renderRail('/chat');

    fireEvent.contextMenu(screen.getByRole('button', { name: 'WhatsApp' }));
    fireEvent.click(screen.getByText('accounts.disconnect'));

    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'accounts/removeAccount',
      payload: { accountId: 'acct-whatsapp' },
    });
    expect(purgeWebviewAccount).toHaveBeenCalledWith('acct-whatsapp');

    // Flush microtasks so the awaited purge rejection reaches the handler's
    // catch (which logs and swallows it) — the disconnect must not throw.
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});

function renderRail(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <SidebarAppRail />
    </MemoryRouter>
  );
}
