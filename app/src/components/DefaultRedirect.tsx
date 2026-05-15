import { Navigate } from 'react-router-dom';

import { useCoreState } from '../providers/CoreStateProvider';
import { DEV_FORCE_ONBOARDING } from '../utils/config';
import RouteLoadingScreen from './RouteLoadingScreen';

/**
 * Default redirect based on auth + onboarding status.
 * - Not logged in → / (Welcome page)
 * - Logged in, onboarding not completed → /onboarding
 * - Logged in, onboarding completed → /home
 *   (the welcome-lock effect in App.tsx may then bounce to /chat
 *   if `chat_onboarding_completed` is still false)
 */
const DefaultRedirect = () => {
  const { isBootstrapping, snapshot } = useCoreState();

  if (isBootstrapping) {
    return <RouteLoadingScreen />;
  }

  if (!snapshot.sessionToken) {
    return <Navigate to="/" replace />;
  }

  // Guard against the post-login race where the session token has arrived
  // (via `core-state:session-token-updated` or `storeSessionToken`) but the
  // snapshot hasn't been refreshed from the core yet. `toSignedOutSnapshot`
  // clears `currentUser` to null on logout, and it stays null until the
  // first post-login `refresh()` resolves with the real snapshot — including
  // the correct `onboardingCompleted` value. Routing to /onboarding here
  // would be wrong for any returning user whose flag is already true.
  if (!snapshot.currentUser) {
    return <RouteLoadingScreen />;
  }

  if (DEV_FORCE_ONBOARDING || !snapshot.onboardingCompleted) {
    return <Navigate to="/onboarding" replace />;
  }

  return <Navigate to="/home" replace />;
};

export default DefaultRedirect;
