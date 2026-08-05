/**
 * Memory-embedding budget state (#5324).
 *
 * The failure this exists to prevent: a heavy user's managed embedding budget
 * runs out, every embed job fails as `unrecoverable`, and the Memory Tree
 * silently stops growing. The only signal was a yellow banner inside a
 * settings panel nobody opens, so users experienced it as "the app has been
 * broken for a month" without knowing why.
 *
 * ## Which budget this reads, and why
 *
 * There is no separate embedding meter. Managed embeddings are billed against
 * the *same* managed cycle budget as chat — the cloud embed route returns the
 * identical `USER_INSUFFICIENT_CREDITS` / "Insufficient budget" error — so
 * `useUsageState().usagePct` is the authoritative consumption figure for both.
 * This hook adds the memory-specific *framing* on top: it only fires when the
 * user's embeddings actually route through that managed budget, and it steers
 * toward the embedding-specific fixes (local Ollama, BYO key) rather than the
 * plan upgrade `GlobalUpsellBanner` already offers.
 *
 * A user on local Ollama or a BYO key is unaffected by the managed budget for
 * embeddings, so they must never see this — a false alarm here would teach
 * users to ignore the real one.
 */
import { useCallback, useEffect, useState } from 'react';

import { loadEmbeddingsSettings } from '../services/api/embeddingsApi';
import { subscribeUsageRefresh } from './usageRefresh';
import { useUsageState } from './useUsageState';

/** Consumption at which the dismissible early warning appears. */
export const EMBEDDING_BUDGET_WARN_PCT = 0.75;
/** Consumption at which the warning becomes non-dismissible. */
export const EMBEDDING_BUDGET_URGENT_PCT = 0.9;

/**
 * Provider slugs that bill against the managed cycle budget. Everything else
 * (`ollama:*`, `openai`, `voyage`, `custom:*`, …) is funded by the user, so
 * the managed budget running out does not stop their memory from growing.
 */
const MANAGED_PROVIDER_SLUGS = ['openhuman', 'managed', 'cloud'];

export type EmbeddingBudgetLevel = 'none' | 'warn' | 'urgent' | 'exhausted';

export interface EmbeddingBudgetState {
  /** Which banner (if any) the user should see. `none` renders nothing. */
  level: EmbeddingBudgetLevel;
  /** Whole-percent consumption, for the warning copy. */
  pct: number;
  /** True while the provider or usage read is still in flight. */
  isLoading: boolean;
  /** True when embeddings bill against the managed budget. */
  isManagedEmbeddings: boolean;
}

/** True when `provider` bills against the managed cycle budget. */
export function isManagedEmbeddingProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  // Providers are stored either bare (`openhuman`) or as `slug:model`
  // (`ollama:nomic-embed-text`), so compare on the slug only.
  const slug = provider.trim().toLowerCase().split(':')[0];
  return MANAGED_PROVIDER_SLUGS.includes(slug);
}

/**
 * Pure threshold mapping, exported so the levels can be tested without
 * mocking the RPC layer.
 *
 * `isExhausted` wins over the percentage because the two can disagree: a
 * hard `remainingUsd <= 0` verdict is authoritative even if the derived
 * percentage rounds to something under 100.
 */
export function embeddingBudgetLevel(usagePct: number, isExhausted: boolean): EmbeddingBudgetLevel {
  if (isExhausted) return 'exhausted';
  if (usagePct >= EMBEDDING_BUDGET_URGENT_PCT) return 'urgent';
  if (usagePct >= EMBEDDING_BUDGET_WARN_PCT) return 'warn';
  return 'none';
}

/**
 * How often the embeddings provider is re-read while it still bills against
 * the managed budget. Matches `useUsageState`'s cache TTL.
 */
const PROVIDER_RECHECK_MS = 60_000;

export function useEmbeddingBudgetState(): EmbeddingBudgetState {
  const { usagePct, isBudgetExhausted, isLoading: usageLoading, teamUsage } = useUsageState();
  const [provider, setProvider] = useState<string | null>(null);
  const [providerLoading, setProviderLoading] = useState(true);
  const [reloadCount, setReloadCount] = useState(0);

  const reload = useCallback(() => setReloadCount(n => n + 1), []);

  // Depend on the *presence* of a usage payload, not the object itself — the
  // object identity is not part of this hook's contract, and keying an effect
  // on it would re-fire the read on every render for any caller whose
  // `useUsageState` returns a fresh object.
  const hasUsage = teamUsage !== null;

  useEffect(() => {
    // No usage payload means signed out / fully routed away / offline — no
    // banner can render in any case, so skip the RPC entirely. Without this
    // the hook fires a core call (and logs a warning) on every cold launch
    // before login, when the core may not even be serving yet.
    if (!hasUsage) {
      setProviderLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const settings = await loadEmbeddingsSettings();
        if (cancelled) return;
        setProvider(settings.provider);
      } catch (err) {
        // Conservative on failure: an unknown provider is treated as
        // NOT managed, so a transient RPC error can never manufacture a
        // budget warning for a user who funds their own embeddings.
        console.warn('[embedding-budget] provider read failed', err);
        if (!cancelled) setProvider(null);
      } finally {
        if (!cancelled) setProviderLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadCount, hasUsage]);

  const isManagedEmbeddings = isManagedEmbeddingProvider(provider);

  // Without this the warning outlives its own fix. The banner is mounted for
  // the app's lifetime, so a single mount-time read means a user who follows
  // the CTA and switches to local Ollama keeps being told their memory is
  // broken until they restart the app — which would make the remediation look
  // like it did not work.
  //
  // Only re-polls while embeddings still bill against the managed budget, so
  // the majority of users (BYO key, local) cost nothing. The subscription
  // below covers the other direction.
  useEffect(() => {
    if (!isManagedEmbeddings) return;
    const id = window.setInterval(reload, PROVIDER_RECHECK_MS);
    return () => window.clearInterval(id);
  }, [isManagedEmbeddings, reload]);

  // Any usage refresh (sign-in, plan change, manual refresh) also re-reads the
  // provider, so a user who *switches onto* managed embeddings starts being
  // warned without waiting for a remount.
  useEffect(() => subscribeUsageRefresh(reload), [reload]);
  const isLoading = usageLoading || providerLoading;

  // No usage payload means the session never reached the billing API (fully
  // routed away, signed out, offline). Claiming a budget state from that is
  // guesswork, so stay silent.
  const level =
    isLoading || !teamUsage || !isManagedEmbeddings
      ? 'none'
      : embeddingBudgetLevel(usagePct, isBudgetExhausted);

  return { level, pct: Math.round(usagePct * 100), isLoading, isManagedEmbeddings };
}
