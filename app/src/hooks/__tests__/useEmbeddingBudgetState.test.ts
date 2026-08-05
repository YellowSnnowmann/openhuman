/**
 * useEmbeddingBudgetState tests (#5324).
 *
 * The two things that must never break: the thresholds the issue specifies,
 * and the guard that keeps users who fund their own embeddings from ever
 * seeing a managed-budget warning. A false alarm here trains users to ignore
 * the real one.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestUsageRefresh } from '../usageRefresh';
import {
  EMBEDDING_BUDGET_URGENT_PCT,
  EMBEDDING_BUDGET_WARN_PCT,
  embeddingBudgetLevel,
  isManagedEmbeddingProvider,
  useEmbeddingBudgetState,
} from '../useEmbeddingBudgetState';

const mockLoadEmbeddingsSettings = vi.hoisted(() => vi.fn());
const mockUseUsageState = vi.hoisted(() => vi.fn());
const mockUseCoreState = vi.hoisted(() => vi.fn());
const mockGetTeamUsage = vi.hoisted(() => vi.fn());

vi.mock('../../services/api/embeddingsApi', () => ({
  loadEmbeddingsSettings: mockLoadEmbeddingsSettings,
}));

vi.mock('../useUsageState', () => ({ useUsageState: mockUseUsageState }));

vi.mock('../../providers/CoreStateProvider', () => ({ useCoreState: mockUseCoreState }));

vi.mock('../../services/api/creditsApi', () => ({
  creditsApi: { getTeamUsage: mockGetTeamUsage },
}));

/** Authenticated session with a managed cycle budget half-consumed. */
function defaultMocks() {
  mockUseCoreState.mockReturnValue({ snapshot: { auth: { isAuthenticated: true } } });
  mockUseUsageState.mockReturnValue({
    usagePct: 0.5,
    isBudgetExhausted: false,
    isLoading: false,
    teamUsage: { cycleBudgetUsd: 10, remainingUsd: 5 },
  });
}

describe('embeddingBudgetLevel', () => {
  it('stays silent below the warning threshold', () => {
    expect(embeddingBudgetLevel(0, false)).toBe('none');
    expect(embeddingBudgetLevel(EMBEDDING_BUDGET_WARN_PCT - 0.01, false)).toBe('none');
  });

  it('warns at exactly 75%', () => {
    expect(embeddingBudgetLevel(EMBEDDING_BUDGET_WARN_PCT, false)).toBe('warn');
  });

  it('escalates at exactly 90%', () => {
    expect(embeddingBudgetLevel(EMBEDDING_BUDGET_URGENT_PCT, false)).toBe('urgent');
    expect(embeddingBudgetLevel(EMBEDDING_BUDGET_URGENT_PCT - 0.001, false)).toBe('warn');
  });

  it('reports exhausted regardless of the derived percentage', () => {
    // The hard `remainingUsd <= 0` verdict is authoritative: a percentage that
    // rounds below 100 must not downgrade an actually-spent budget.
    expect(embeddingBudgetLevel(0.97, true)).toBe('exhausted');
    expect(embeddingBudgetLevel(0, true)).toBe('exhausted');
  });
});

describe('isManagedEmbeddingProvider', () => {
  it('recognises the managed provider slugs', () => {
    expect(isManagedEmbeddingProvider('openhuman')).toBe(true);
    expect(isManagedEmbeddingProvider('managed')).toBe(true);
    expect(isManagedEmbeddingProvider('cloud')).toBe(true);
  });

  it('matches on the slug when a model suffix is present', () => {
    expect(isManagedEmbeddingProvider('openhuman:voyage-3')).toBe(true);
    expect(isManagedEmbeddingProvider('ollama:nomic-embed-text')).toBe(false);
  });

  it('treats user-funded providers as unaffected by the managed budget', () => {
    for (const p of ['ollama', 'openai', 'voyage', 'custom:http://localhost:1234']) {
      expect(isManagedEmbeddingProvider(p)).toBe(false);
    }
  });

  it('is conservative about an unknown provider', () => {
    // A failed provider read must never manufacture a budget warning.
    expect(isManagedEmbeddingProvider(null)).toBe(false);
    expect(isManagedEmbeddingProvider(undefined)).toBe(false);
    expect(isManagedEmbeddingProvider('')).toBe(false);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(isManagedEmbeddingProvider('  OpenHuman  ')).toBe(true);
  });
});

// ── #5324: the provider must be re-read, or the warning outlives its fix ────

describe('useEmbeddingBudgetState provider refresh', () => {
  beforeEach(() => {
    mockLoadEmbeddingsSettings.mockReset();
    mockGetTeamUsage.mockReset();
    defaultMocks();
  });

  it('re-reads the provider on an interval while embeddings are managed', async () => {
    vi.useFakeTimers();
    mockLoadEmbeddingsSettings.mockResolvedValue({ provider: 'openhuman' });
    const { result, unmount } = renderHook(() => useEmbeddingBudgetState());

    // Flush the initial read inside `act` so `setProvider` commits before the
    // assertions — otherwise the managed-gated interval below never arms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockLoadEmbeddingsSettings).toHaveBeenCalledTimes(1);
    expect(result.current.isManagedEmbeddings).toBe(true);

    // A user who follows the CTA and switches to local Ollama must stop being
    // told their memory is broken, without restarting the app.
    mockLoadEmbeddingsSettings.mockResolvedValue({ provider: 'ollama:nomic-embed-text' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockLoadEmbeddingsSettings).toHaveBeenCalledTimes(2);
    expect(result.current.isManagedEmbeddings).toBe(false);

    // Once off the managed budget the polling stops — no cost for the majority
    // of users who fund their own embeddings.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(mockLoadEmbeddingsSettings).toHaveBeenCalledTimes(2);

    unmount();
    vi.useRealTimers();
  });

  it('re-reads the provider when usage refreshes', async () => {
    mockLoadEmbeddingsSettings.mockResolvedValue({ provider: 'ollama' });
    renderHook(() => useEmbeddingBudgetState());
    await vi.waitFor(() => expect(mockLoadEmbeddingsSettings).toHaveBeenCalledTimes(1));

    // The other direction: a user switching ONTO managed embeddings starts
    // being warned without waiting for a remount.
    requestUsageRefresh();
    await vi.waitFor(() => expect(mockLoadEmbeddingsSettings).toHaveBeenCalledTimes(2));
  });
});

// ── #5324: session boundaries + the routed-away managed-embeddings gap ──────

describe('useEmbeddingBudgetState session + managed-embeddings gaps', () => {
  beforeEach(() => {
    mockLoadEmbeddingsSettings.mockReset();
    mockGetTeamUsage.mockReset();
    defaultMocks();
  });

  // CodeRabbit: a managed provider carried over from a previous user must not
  // combine with a new session's usage into a false warning.
  it('clears a stale managed provider when the session ends', async () => {
    mockLoadEmbeddingsSettings.mockResolvedValue({ provider: 'openhuman' });
    const { result, rerender } = renderHook(() => useEmbeddingBudgetState());
    await vi.waitFor(() => expect(result.current.isManagedEmbeddings).toBe(true));

    // Sign out: no live session, no usage payload.
    mockUseCoreState.mockReturnValue({ snapshot: { auth: { isAuthenticated: false } } });
    mockUseUsageState.mockReturnValue({
      usagePct: 0,
      isBudgetExhausted: false,
      isLoading: false,
      teamUsage: null,
    });
    rerender();

    await vi.waitFor(() => {
      expect(result.current.isManagedEmbeddings).toBe(false);
      expect(result.current.level).toBe('none');
    });
  });

  // Codex: chat + background workloads routed off OpenHuman (so useUsageState
  // reports no payload) while embeddings stay on the managed budget. The
  // warning must still reach this user via a direct budget read.
  it('warns a routed-away user whose embeddings still bill against the managed budget', async () => {
    mockUseUsageState.mockReturnValue({
      usagePct: 0,
      isBudgetExhausted: false,
      isLoading: false,
      teamUsage: null,
    });
    mockLoadEmbeddingsSettings.mockResolvedValue({ provider: 'openhuman' });
    mockGetTeamUsage.mockResolvedValue({ cycleBudgetUsd: 10, remainingUsd: 1 });

    const { result } = renderHook(() => useEmbeddingBudgetState());

    await vi.waitFor(() => {
      expect(mockGetTeamUsage).toHaveBeenCalledTimes(1);
      expect(result.current.level).toBe('urgent');
      expect(result.current.pct).toBe(90);
    });
  });

  // A failed direct read must never manufacture a warning.
  it('stays silent when the direct budget read fails', async () => {
    mockUseUsageState.mockReturnValue({
      usagePct: 0,
      isBudgetExhausted: false,
      isLoading: false,
      teamUsage: null,
    });
    mockLoadEmbeddingsSettings.mockResolvedValue({ provider: 'openhuman' });
    mockGetTeamUsage.mockRejectedValue(new Error('usage unavailable'));

    const { result } = renderHook(() => useEmbeddingBudgetState());

    await vi.waitFor(() => expect(mockGetTeamUsage).toHaveBeenCalled());
    expect(result.current.level).toBe('none');
    expect(result.current.isManagedEmbeddings).toBe(true);
  });

  // The common managed user (useUsageState already has the figure) must not
  // pay for a second billing round-trip.
  it('does not issue a direct budget read when useUsageState already has usage', async () => {
    mockLoadEmbeddingsSettings.mockResolvedValue({ provider: 'openhuman' });
    const { result } = renderHook(() => useEmbeddingBudgetState());
    await vi.waitFor(() => expect(result.current.isManagedEmbeddings).toBe(true));
    expect(mockGetTeamUsage).not.toHaveBeenCalled();
    expect(result.current.pct).toBe(50);
  });

  // A routed-away user on local/BYO embeddings still sees nothing — and we do
  // not even issue the direct read for them.
  it('never reads the managed budget for a routed-away BYO-embeddings user', async () => {
    mockUseUsageState.mockReturnValue({
      usagePct: 0,
      isBudgetExhausted: false,
      isLoading: false,
      teamUsage: null,
    });
    mockLoadEmbeddingsSettings.mockResolvedValue({ provider: 'ollama:nomic-embed-text' });

    const { result } = renderHook(() => useEmbeddingBudgetState());
    await vi.waitFor(() => expect(mockLoadEmbeddingsSettings).toHaveBeenCalled());
    expect(mockGetTeamUsage).not.toHaveBeenCalled();
    expect(result.current.level).toBe('none');
    expect(result.current.isManagedEmbeddings).toBe(false);
  });
});
