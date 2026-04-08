import { useEffect, useMemo, useState } from 'react';

import ProgressIndicator from '../../components/ProgressIndicator';
import { useCoreState } from '../../providers/CoreStateProvider';
import { referralApi } from '../../services/api/referralApi';
import { userApi } from '../../services/api/userApi';
import { getDefaultEnabledTools } from '../../utils/toolDefinitions';
import ReferralApplyStep from './steps/ReferralApplyStep';
import ScreenPermissionsStep from './steps/ScreenPermissionsStep';
import SkillsStep from './steps/SkillsStep';
import WelcomeStep from './steps/WelcomeStep';

interface OnboardingProps {
  onComplete?: () => void;
  onDefer?: () => void;
}

interface OnboardingDraft {
  accessibilityPermissionGranted: boolean;
  connectedSources: string[];
}

function hasReferralFromProfile(
  user:
    | { referral?: { invitedBy?: string | null; invitedByCode?: string | null } }
    | null
    | undefined
): boolean {
  return !!(user?.referral?.invitedBy || user?.referral?.invitedByCode);
}

const Onboarding = ({ onComplete, onDefer }: OnboardingProps) => {
  const { setOnboardingCompletedFlag, setOnboardingTasks, snapshot } = useCoreState();
  const [currentStep, setCurrentStep] = useState(0);
  const [draft, setDraft] = useState<OnboardingDraft>({
    accessibilityPermissionGranted: false,
    connectedSources: [],
  });
  const [skipReferralStep, setSkipReferralStep] = useState(false);
  const [referralGateReady, setReferralGateReady] = useState(false);
  const [referralAppliedThisSession, setReferralAppliedThisSession] = useState(false);

  const token = snapshot.sessionToken;
  const currentUser = snapshot.currentUser;

  const profileAlreadyReferred = useMemo(() => hasReferralFromProfile(currentUser), [currentUser]);

  useEffect(() => {
    if (!token) {
      setSkipReferralStep(false);
      setReferralGateReady(true);
      return;
    }

    if (profileAlreadyReferred) {
      setSkipReferralStep(true);
      setReferralGateReady(true);
      return;
    }

    let cancelled = false;
    setReferralGateReady(false);
    (async () => {
      try {
        const stats = await referralApi.getStats();
        const applied =
          typeof stats.appliedReferralCode === 'string' && stats.appliedReferralCode.trim() !== '';
        if (!cancelled) {
          setSkipReferralStep(applied);
          setReferralGateReady(true);
        }
      } catch {
        console.debug('[onboarding] referral preflight failed; showing referral step');
        if (!cancelled) {
          setSkipReferralStep(false);
          setReferralGateReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, profileAlreadyReferred]);

  useEffect(() => {
    if (skipReferralStep && currentStep === 1) {
      setCurrentStep(2);
    }
  }, [skipReferralStep, currentStep]);

  const totalSteps = skipReferralStep ? 3 : 4;
  const progressCurrentStep = skipReferralStep
    ? currentStep === 0
      ? 0
      : currentStep === 2
        ? 1
        : 2
    : currentStep;

  const handleWelcomeNext = () => {
    if (skipReferralStep) {
      setCurrentStep(2);
    } else {
      setCurrentStep(1);
    }
  };

  const handleNext = () => {
    if (currentStep < 3) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handleBack = () => {
    if (currentStep <= 0) return;
    if (
      currentStep === 2 &&
      (skipReferralStep || profileAlreadyReferred || referralAppliedThisSession)
    ) {
      setCurrentStep(0);
      return;
    }
    setCurrentStep(currentStep - 1);
  };

  const handleAccessibilityNext = (accessibilityPermissionGranted: boolean) => {
    setDraft(prev => ({ ...prev, accessibilityPermissionGranted }));
    handleNext();
  };

  const handleSkillsNext = async (connectedSources: string[]) => {
    setDraft(prev => ({ ...prev, connectedSources }));

    await setOnboardingTasks({
      accessibilityPermissionGranted: draft.accessibilityPermissionGranted,
      localModelConsentGiven: false,
      localModelDownloadStarted: false,
      enabledTools: getDefaultEnabledTools(),
      connectedSources,
      updatedAtMs: Date.now(),
    });

    // Notify backend (best-effort — don't block onboarding completion)
    try {
      await userApi.onboardingComplete();
    } catch {
      console.warn('[onboarding] Failed to notify backend of onboarding completion');
    }

    // Write onboarding_completed to core config (source of truth)
    try {
      await setOnboardingCompletedFlag(true);
    } catch {
      console.warn('[onboarding] Failed to persist onboarding_completed to core config');
    }

    onComplete?.();
  };

  const renderStep = () => {
    switch (currentStep) {
      case 0:
        return (
          <WelcomeStep
            onNext={handleWelcomeNext}
            nextDisabled={!referralGateReady}
            nextLoading={!!token && !referralGateReady}
            nextLoadingLabel="Checking account…"
          />
        );
      case 1:
        return (
          <ReferralApplyStep
            onNext={handleNext}
            onBack={handleBack}
            onApplied={() => setReferralAppliedThisSession(true)}
          />
        );
      case 2:
        return <ScreenPermissionsStep onNext={handleAccessibilityNext} onBack={handleBack} />;
      case 3:
        return <SkillsStep onNext={handleSkillsNext} onBack={handleBack} />;
      default:
        return null;
    }
  };

  return (
    <div className="min-h-full relative flex items-center justify-center">
      {onDefer && (
        <div className="fixed top-4 right-0 z-20 sm:top-6 sm:right-6">
          <button
            type="button"
            onClick={onDefer}
            className="text-sm text-stone-600 hover:text-stone-900 transition-colors">
            Skip
          </button>
        </div>
      )}
      <div className="relative z-10 max-w-lg w-full mx-4">
        <ProgressIndicator currentStep={progressCurrentStep} totalSteps={totalSteps} />
        {renderStep()}
      </div>
    </div>
  );
};

export default Onboarding;
