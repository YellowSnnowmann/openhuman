/**
 * Modal popped open when an `<openhuman-link path="...">` pill is clicked
 * inside an agent message bubble.
 *
 * The pill dispatches a `window` `CustomEvent('openhuman-link', { detail: { path } })`;
 * this component listens for it, opens the modal, and routes to a focused
 * mini-flow per path. Keeps the chat in view (no react-router navigation)
 * so the user can complete the action and return to the agent without
 * losing the conversation.
 *
 * Mounted once at AppShell root.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useChannelDefinitions } from '../hooks/useChannelDefinitions';
import { useT } from '../lib/i18n/I18nContext';
import {
  ensureNotificationPermission,
  getNotificationPermissionState,
  type NotificationPermissionState,
  showNativeNotification,
} from '../lib/nativeNotifications/tauriBridge';
import { isTauri, purgeWebviewAccount } from '../services/webviewAccountService';
import { removeAccount } from '../store/accountsSlice';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import {
  type Account,
  type AccountProvider,
  type AccountStatus,
  PROVIDERS,
} from '../types/accounts';
import { BILLING_DASHBOARD_URL, DISCORD_INVITE_URL } from '../utils/links';
import { openUrl } from '../utils/openUrl';
import { ProviderIcon } from './accounts/providerIcons';
import ChannelSetupModal from './channels/ChannelSetupModal';
import Button from './ui/Button';

interface OpenhumanLinkEvent {
  path: string;
}

export const OPENHUMAN_LINK_EVENT = 'openhuman-link';

const ALLOWED_PATHS = [
  'settings/notifications',
  'settings/billing',
  'settings/messaging',
  'community/discord',
  'community/discord-report',
  'accounts/setup',
] as const;

type AllowedPath = (typeof ALLOWED_PATHS)[number];

const ALLOWED_PATHS_SET = new Set<string>(ALLOWED_PATHS);

const OpenhumanLinkModal = () => {
  const { t } = useT();
  const [activePath, setActivePath] = useState<AllowedPath | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<OpenhumanLinkEvent>).detail;
      if (detail?.path && ALLOWED_PATHS_SET.has(detail.path)) {
        setActivePath(detail.path as AllowedPath);
      }
    };
    window.addEventListener(OPENHUMAN_LINK_EVENT, handler);
    return () => window.removeEventListener(OPENHUMAN_LINK_EVENT, handler);
  }, []);

  const close = useCallback(() => setActivePath(null), []);

  if (!activePath) return null;

  // Telegram (and any future channel) gets the dedicated `ChannelSetupModal`
  // already used by Skills + Settings instead of a bespoke body wrapper.
  // It manages its own portal + backdrop, so render it standalone.
  if (activePath === 'settings/messaging') {
    return <MessagingSetupBridge onClose={close} />;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={close}
      role="dialog"
      aria-modal="true">
      <div
        className="w-full max-w-md rounded-2xl bg-surface shadow-xl overflow-hidden"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line-subtle px-5 py-3">
          <h2 className="text-sm font-semibold text-content">{titleForPath(activePath, t)}</h2>
          <Button
            iconOnly
            variant="tertiary"
            size="xs"
            onClick={close}
            aria-label={t('common.close')}>
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 6l12 12M6 18L18 6"
              />
            </svg>
          </Button>
        </div>
        <div className="p-5">{renderBody(activePath, close)}</div>
      </div>
    </div>
  );
};

/**
 * Resolves the Telegram channel definition and hands it to the shared
 * `ChannelSetupModal` (same component the Settings → Messaging panel
 * uses). When definitions are still loading we render a tiny placeholder
 * so the user gets feedback instead of a flashing screen.
 */
const MessagingSetupBridge = ({ onClose }: { onClose: () => void }) => {
  const { t } = useT();
  const { definitions, loading } = useChannelDefinitions();
  const telegram = useMemo(() => definitions.find(d => d.id === 'telegram') ?? null, [definitions]);

  if (loading && !telegram) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="rounded-2xl bg-surface px-6 py-4 text-sm text-content-secondary shadow-xl">
          {t('app.openhumanLink.loadingChannelSetup')}
        </div>
      </div>
    );
  }

  if (!telegram) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        onClick={onClose}>
        <div
          className="rounded-2xl bg-surface p-6 text-sm text-content-secondary shadow-xl max-w-sm"
          onClick={e => e.stopPropagation()}>
          <p>{t('app.openhumanLink.telegramUnavailable')}</p>
          <div className="mt-3 flex justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('common.close')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return <ChannelSetupModal definition={telegram} onClose={onClose} />;
};

function titleForPath(path: AllowedPath, t: (k: string) => string): string {
  switch (path) {
    case 'settings/notifications':
      return t('app.openhumanLink.title.notifications');
    case 'settings/billing':
      return t('app.openhumanLink.title.billing');
    case 'settings/messaging':
      return t('app.openhumanLink.title.messaging');
    case 'community/discord':
      return t('app.openhumanLink.title.discord');
    case 'community/discord-report':
      return t('app.openhumanLink.title.discordReport');
    case 'accounts/setup':
      return t('app.openhumanLink.title.accounts');
  }
}

function renderBody(path: AllowedPath, close: () => void) {
  switch (path) {
    case 'settings/notifications':
      return <NotificationsBody close={close} />;
    case 'settings/billing':
      return <BillingBody close={close} />;
    case 'settings/messaging':
      // Routed via the dedicated `MessagingSetupBridge` above; this case
      // is kept to satisfy the path-completeness check but is unreachable
      // because the parent component returns the bridge before calling
      // `renderBody`.
      return null;
    case 'community/discord':
      return <DiscordBody close={close} />;
    case 'community/discord-report':
      return <DiscordReportBody close={close} />;
    case 'accounts/setup':
      return <AccountsSetupBody close={close} />;
  }
}

// ── Notifications ────────────────────────────────────────────────────────

const NotificationsBody = ({ close }: { close: () => void }) => {
  const { t } = useT();
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [permissionState, setPermissionState] = useState<NotificationPermissionState>('unknown');

  useEffect(() => {
    let mounted = true;
    void getNotificationPermissionState({ requestIfNeeded: false }).then(next => {
      if (!mounted) return;
      setPermissionState(next);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const handleAllow = async () => {
    if (status === 'sending') {
      return;
    }

    setStatus('sending');
    setError(null);
    try {
      if (!isTauri()) {
        setStatus('error');
        setError(t('app.openhumanLink.notifications.desktopOnly'));
        return;
      }

      const granted = await ensureNotificationPermission();
      if (!granted) {
        const nextState = await getNotificationPermissionState({ requestIfNeeded: false });
        setPermissionState(nextState);
        setStatus('error');
        setError(t('app.openhumanLink.notifications.permissionOff'));
        return;
      }
      const sendResult = await showNativeNotification({
        title: t('app.openhumanLink.notifications.welcomeTitle'),
        body: t('app.openhumanLink.notifications.welcomeBody'),
        tag: 'welcome-notification-test',
      });
      if (!sendResult.delivered) {
        setStatus('error');
        setError(sendResult.error ?? t('app.openhumanLink.notifications.triggerFailed'));
        return;
      }
      setPermissionState('granted');
      setStatus('sent');
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-4 text-sm text-content-secondary">
      <p>{t('app.openhumanLink.notifications.intro')}</p>
      {permissionState === 'denied' && (
        <div className="rounded-xl border border-coral-200 bg-coral-50 dark:bg-coral-500/15 p-3 text-xs text-coral-700 dark:text-coral-300">
          {t('app.openhumanLink.notifications.blocked')}
          <br />
          {t('app.openhumanLink.notifications.blockedStep1')}
          <br />
          {t('app.openhumanLink.notifications.blockedStep2')}
          <br />
          {t('app.openhumanLink.notifications.blockedStep3')}
        </div>
      )}
      {(permissionState === 'prompt' || permissionState === 'unknown') && (
        <div className="rounded-xl border border-line bg-surface-muted p-3 text-xs text-content-secondary">
          {t('app.openhumanLink.notifications.promptHint')}
        </div>
      )}
      <Button onClick={() => void handleAllow()} disabled={status === 'sending'} className="w-full">
        {status === 'sending'
          ? t('app.openhumanLink.notifications.asking')
          : status === 'error'
            ? t('app.openhumanLink.notifications.retry')
            : t('app.openhumanLink.notifications.send')}
      </Button>
      {status === 'sent' && (
        <p className="text-xs text-sage-700">{t('app.openhumanLink.notifications.sent')}</p>
      )}
      {status === 'error' && (
        <p className="text-xs text-coral-600">
          {t('app.openhumanLink.notifications.sendFailed').replace('{error}', error ?? '')}
        </p>
      )}
      <DoneFooter close={close} />
    </div>
  );
};

// ── Billing ──────────────────────────────────────────────────────────────

const BillingBody = ({ close }: { close: () => void }) => {
  const { t } = useT();
  return (
    <div className="space-y-4 text-sm text-content-secondary">
      <div className="rounded-xl border border-line bg-surface-muted p-4">
        <p className="text-xs uppercase tracking-wide text-content-muted">
          {t('app.openhumanLink.billing.trialCredit')}
        </p>
        <p className="mt-1 text-2xl font-semibold text-content">
          {t('onboarding.runtimeChoice.cloud.creditHighlight')}
        </p>
        <p className="mt-1 text-xs text-content-muted">
          {t('app.openhumanLink.billing.trialDesc')}
        </p>
      </div>
      <Button
        onClick={() => {
          void openUrl(BILLING_DASHBOARD_URL).catch(() => {});
        }}
        className="w-full">
        {t('app.openhumanLink.billing.openDashboard')}
      </Button>
      <DoneFooter close={close} skipLabel={t('app.openhumanLink.billing.stayOnTrial')} />
    </div>
  );
};

// ── Discord ──────────────────────────────────────────────────────────────

const DiscordBody = ({ close }: { close: () => void }) => {
  const { t } = useT();
  return (
    <div className="space-y-4 text-sm text-content-secondary">
      <p>{t('app.openhumanLink.discord.intro')}</p>
      <ul className="space-y-1.5 text-xs text-content-secondary pl-1">
        <li className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-primary-400 flex-shrink-0" />
          {t('app.openhumanLink.discord.perk1')}
        </li>
        <li className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-primary-400 flex-shrink-0" />
          {t('app.openhumanLink.discord.perk2')}
        </li>
        <li className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-primary-400 flex-shrink-0" />
          {t('app.openhumanLink.discord.perk3')}
        </li>
        <li className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-primary-400 flex-shrink-0" />
          {t('app.openhumanLink.discord.perk4')}
        </li>
      </ul>
      <Button
        onClick={async () => {
          try {
            await openUrl(DISCORD_INVITE_URL);
          } catch {
            // Ignore launcher errors from OS URL handler failures.
          }
        }}
        className="w-full">
        {t('app.openhumanLink.discord.openInvite')}
      </Button>
      <DoneFooter close={close} skipLabel={t('app.openhumanLink.maybeLater')} />
    </div>
  );
};

/**
 * Error-report variant of the Discord modal. Shown when an agent error pill
 * with path "community/discord-report" is clicked. Distinct from DiscordBody
 * (join-community flow):
 *  - Leads with an apology/acknowledgement copy.
 *  - Offers an "Open Discord" primary button to jump straight to the server
 *    (and closes the modal).
 */
const DiscordReportBody = ({ close }: { close: () => void }) => {
  const { t } = useT();

  return (
    <div className="space-y-4 text-sm text-content-secondary">
      <p>{t('app.openhumanLink.discordReport.intro')}</p>
      <Button
        onClick={async () => {
          try {
            await openUrl(DISCORD_INVITE_URL);
          } finally {
            close();
          }
        }}
        className="w-full">
        {t('app.openhumanLink.discordReport.openDiscord')}
      </Button>
    </div>
  );
};

// ── Accounts setup (multi-channel toggle list) ──────────────────────────

/**
 * Curated list of providers shown in the welcome flow's "Connect your apps"
 * step. Excludes call-only surfaces (`google-meet`, `zoom`) and dev-only
 * (`browserscan`) — those still appear in the full Add Account modal but
 * aren't a "set this up during onboarding" target.
 */
const ACCOUNTS_SETUP_PROVIDERS: readonly AccountProvider[] = [
  'whatsapp',
  'wechat',
  'telegram',
  'slack',
  'discord',
  'linkedin',
];

/**
 * Translation key + color for a given account lifecycle status. Returns a
 * `labelKey` (not a literal) so the caller can localize it via `useT()` —
 * this is a module-level helper with no hook scope of its own.
 */
export function statusDisplay(status: AccountStatus): { labelKey: string; dotClass: string } {
  switch (status) {
    case 'open':
      return { labelKey: 'app.openhumanLink.status.connected', dotClass: 'bg-emerald-500' };
    case 'loading':
      return { labelKey: 'app.openhumanLink.status.loading', dotClass: 'bg-amber-400' };
    case 'pending':
      return { labelKey: 'app.openhumanLink.status.needsSignIn', dotClass: 'bg-amber-400' };
    case 'timeout':
      return { labelKey: 'app.openhumanLink.status.timedOut', dotClass: 'bg-red-400' };
    case 'error':
      return { labelKey: 'app.openhumanLink.status.error', dotClass: 'bg-red-400' };
    case 'closed':
      return { labelKey: 'app.openhumanLink.status.closed', dotClass: 'bg-stone-300' };
  }
}

const AccountsSetupBody = ({ close }: { close: () => void }) => {
  const { t } = useT();
  const dispatch = useAppDispatch();
  const accountsById = useAppSelector(s => s.accounts.accounts);
  const order = useAppSelector(s => s.accounts.order);

  // Map provider → first existing account (one provider, one row).
  const accountByProvider = useMemo(() => {
    const map = new Map<AccountProvider, Account>();
    for (const id of order) {
      const acct = accountsById[id];
      if (acct && !map.has(acct.provider)) map.set(acct.provider, acct);
    }
    return map;
  }, [accountsById, order]);

  // #5423 — the in-app web-apps feature is being removed after 31 August 2026.
  // Only apps the user already connected are listed here; connecting a new one
  // is no longer offered. A user with none connected sees just the removal
  // notice below.
  const connectedDescriptors = useMemo(
    () =>
      ACCOUNTS_SETUP_PROVIDERS.map(id => PROVIDERS.find(p => p.id === id)).filter(
        (p): p is (typeof PROVIDERS)[number] => p !== undefined && accountByProvider.has(p.id)
      ),
    [accountByProvider]
  );

  const handleDisconnect = (providerId: AccountProvider) => {
    const existing = accountByProvider.get(providerId);
    if (!existing) return;
    void purgeWebviewAccount(existing.id).catch(() => {});
    dispatch(removeAccount({ accountId: existing.id }));
  };

  const doneLabel = t('app.openhumanLink.accounts.done');

  return (
    <div className="space-y-4 text-sm text-content-secondary">
      <div
        data-testid="openhuman-link-webapps-sunset"
        className="rounded-xl border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-500/15">
        <p className="text-xs font-medium text-blue-700 dark:text-blue-300">
          {t('webAppsSunset.title')}
        </p>
        <p className="text-xs text-blue-600 dark:text-blue-300">{t('webAppsSunset.message')}</p>
      </div>
      {connectedDescriptors.length > 0 && (
        <div className="space-y-2">
          {connectedDescriptors.map(p => {
            const status = accountByProvider.get(p.id)?.status;
            return (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-xl border border-line-subtle bg-surface p-3">
                <ProviderIcon provider={p.id} className="h-5 w-5 flex-none" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-content">{p.label}</div>
                  {status ? (
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${statusDisplay(status).dotClass}`}
                      />
                      <span className="text-xs text-content-muted">
                        {t(statusDisplay(status).labelKey)}
                      </span>
                    </div>
                  ) : (
                    <p className="line-clamp-1 text-xs text-content-muted">{p.description}</p>
                  )}
                </div>
                {/* Only disconnect is offered — the feature is being removed, so
                    re-adding a service is intentionally not possible here. */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={true}
                  aria-label={`${t('skills.disconnect')} ${p.label}`}
                  onClick={() => handleDisconnect(p.id)}
                  className="relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full bg-primary-500 transition-colors">
                  <span className="inline-block h-5 w-5 translate-x-5 transform rounded-full bg-surface shadow transition-transform" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-xs text-content-faint">{t('app.openhumanLink.accounts.webviewNote')}</p>
      <DoneFooter close={close} onDone={close} doneLabel={doneLabel} />
    </div>
  );
};

// ── Shared footer ────────────────────────────────────────────────────────

const DoneFooter = ({
  close,
  onDone,
  doneLabel,
  skipLabel,
}: {
  close: () => void;
  onDone?: () => void;
  doneLabel?: string;
  skipLabel?: string;
}) => {
  const { t } = useT();
  const resolvedDone = doneLabel ?? t('app.openhumanLink.done');
  const resolvedSkip = skipLabel ?? t('app.openhumanLink.skipForNow');
  return (
    <div className="flex items-center justify-between gap-3 pt-1">
      <Button variant="tertiary" size="sm" onClick={close}>
        {resolvedSkip}
      </Button>
      <Button variant="secondary" size="sm" onClick={onDone ?? close}>
        {resolvedDone}
      </Button>
    </div>
  );
};

export default OpenhumanLinkModal;
