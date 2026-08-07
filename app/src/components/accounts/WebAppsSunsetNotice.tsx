/**
 * In-app web-apps removal notice (#5423).
 *
 * Shell-mounted beside the other content-top banners so it reaches users on
 * whatever screen they are on. Shown only to users who already have at least
 * one web app connected — a user with none connected sees no trace of the
 * feature at all (the "Add apps" affordance is gone from {@link
 * SidebarAppRail}), so a notice for them would advertise a feature they never
 * had.
 *
 * Non-dismissible on purpose: the feature is going away on a fixed date, so the
 * notice must stay visible until then rather than being silenced once.
 */
import { useT } from '../../lib/i18n/I18nContext';
import { useAppSelector } from '../../store/hooks';
import UpsellBanner from '../upsell/UpsellBanner';

export default function WebAppsSunsetNotice() {
  const { t } = useT();
  // `order` holds only real provider accounts (the agent tile is virtual and
  // never enters the store), so a non-empty order means the user has connected
  // at least one web app.
  const hasConnectedApps = useAppSelector(state => state.accounts.order.length > 0);

  if (!hasConnectedApps) return null;

  return (
    <div className="relative z-20" data-testid="web-apps-sunset-notice">
      <UpsellBanner
        variant="info"
        title={t('webAppsSunset.title')}
        message={t('webAppsSunset.message')}
        rounded={false}
        dismissible={false}
      />
    </div>
  );
}
