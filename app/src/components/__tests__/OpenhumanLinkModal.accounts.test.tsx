import { combineReducers, configureStore } from '@reduxjs/toolkit';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import accountsReducer from '../../store/accountsSlice';
import OpenhumanLinkModal, { OPENHUMAN_LINK_EVENT } from '../OpenhumanLinkModal';

// Mock modules that require Tauri runtime
vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(() => false) }));
vi.mock('../../lib/nativeNotifications/tauriBridge', () => ({
  ensureNotificationPermission: vi.fn(),
  getNotificationPermissionState: vi.fn().mockResolvedValue('prompt'),
  showNativeNotification: vi.fn(),
}));
vi.mock('../../services/webviewAccountService', () => ({
  isTauri: vi.fn(() => false),
  purgeWebviewAccount: vi.fn().mockResolvedValue(undefined),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

function createStore() {
  return configureStore({
    reducer: combineReducers({
      accounts: accountsReducer,
      // Stubs for selectors that may be read elsewhere
      channelConnections: () => ({}),
    }),
  });
}

function seedAccount(
  store: ReturnType<typeof createStore>,
  provider: string,
  status: string,
  id = `test-${provider}`
) {
  store.dispatch({
    type: 'accounts/addAccount',
    payload: { id, provider, label: provider, createdAt: new Date().toISOString(), status },
  });
}

function renderModal(store = createStore()) {
  return {
    store,
    ...render(
      <Provider store={store}>
        <MemoryRouter>
          <OpenhumanLinkModal />
        </MemoryRouter>
      </Provider>
    ),
  };
}

function openAccountsModal() {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(OPENHUMAN_LINK_EVENT, { detail: { path: 'accounts/setup' } })
    );
  });
}

describe('OpenhumanLinkModal accounts setup (sunset, #5423)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the removal notice for a user with connected web apps', () => {
    const store = createStore();
    seedAccount(store, 'telegram', 'open');
    renderModal(store);
    openAccountsModal();

    expect(screen.getByTestId('openhuman-link-webapps-sunset')).toBeInTheDocument();
  });

  it('renders no trace of the feature for a user with no connected apps (#5423)', () => {
    renderModal();
    openAccountsModal();

    // The accounts/setup deep link stays reachable (old pills can dispatch it),
    // but a never-connected user must see nothing of the retired feature — the
    // step is a no-op with no notice and no controls.
    expect(screen.queryByTestId('openhuman-link-webapps-sunset')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  });

  it('does not offer to connect a provider the user has not already connected', () => {
    const store = createStore();
    seedAccount(store, 'telegram', 'open');
    renderModal(store);
    openAccountsModal();

    // The add path is gone: no "Connect X" toggles for un-connected providers,
    // so a user cannot pick up a service they were not already using.
    expect(screen.queryByLabelText('Connect WhatsApp Web')).toBeNull();
    expect(screen.queryByLabelText('Connect Discord')).toBeNull();
  });

  it('lists an already-connected app with a disconnect control', () => {
    const store = createStore();
    seedAccount(store, 'telegram', 'open');
    renderModal(store);
    openAccountsModal();

    // The connected app is shown (by its catalog label) and can be disconnected.
    expect(screen.getByLabelText('Disconnect Telegram Web')).toBeInTheDocument();
  });

  it('disconnect removes the connected account from the store', () => {
    const store = createStore();
    seedAccount(store, 'telegram', 'open');
    renderModal(store);
    openAccountsModal();

    fireEvent.click(screen.getByLabelText('Disconnect Telegram Web'));
    expect(Object.values(store.getState().accounts.accounts)).toHaveLength(0);
  });

  it('shows a status indicator for a connected account', () => {
    const store = createStore();
    seedAccount(store, 'telegram', 'open');
    renderModal(store);
    openAccountsModal();

    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('shows "Needs sign-in" for an account with pending status', () => {
    const store = createStore();
    seedAccount(store, 'slack', 'pending');
    renderModal(store);
    openAccountsModal();

    expect(screen.getByText('Needs sign-in')).toBeInTheDocument();
  });

  it('Done closes the modal without navigating', () => {
    const store = createStore();
    seedAccount(store, 'telegram', 'open');
    renderModal(store);
    openAccountsModal();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('Skip closes the modal without navigating', () => {
    const store = createStore();
    seedAccount(store, 'telegram', 'open');
    renderModal(store);
    openAccountsModal();

    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
