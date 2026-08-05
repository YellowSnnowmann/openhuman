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

vi.mock('../../services/api/embeddingsApi', () => ({
  loadEmbeddingsSettings: mockLoadEmbeddingsSettings,
}));

// The hook under test only needs a stable usage payload here; the threshold
// mapping is covered by the pure-function tests above.
vi.mock('../useUsageState', () => ({
  useUsageState: () => ({
    usagePct: 0.5,
    isBudgetExhausted: false,
    isLoading: false,
    teamUsage: { cycleBudgetUsd: 10, remainingUsd: 5 },
  }),
}));

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
