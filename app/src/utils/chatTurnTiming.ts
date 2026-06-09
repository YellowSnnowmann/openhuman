import debug from 'debug';

import { trackEvent } from '../services/analytics';

const timingLog = debug('realtime:chat:timing');

/**
 * Client-side latency instrumentation for a chat turn. Captures the two
 * user-perceived numbers the staging-latency investigation
 * (tinyhumansai/openhuman#3491) found nowhere on the client:
 *
 * - TTFT: submit -> first visible output token (text or thinking).
 * - total: submit -> chat_done.
 *
 * Timing uses `performance.now()` (monotonic) so it is immune to wall-clock
 * adjustments. State is keyed by threadId; a turn is started on submit and
 * cleared on completion. A late/duplicate first-token or done event for an
 * unknown thread is ignored.
 */
interface TurnTiming {
  submitAt: number;
  firstTokenAt?: number;
}

const turnsByThread = new Map<string, TurnTiming>();

function nowMs(): number {
  const perf = globalThis.performance;
  return perf && typeof perf.now === 'function' ? perf.now() : Date.now();
}

/** Record the moment the user submitted a turn for `threadId`. */
export function markChatSubmit(threadId: string): void {
  if (!threadId) return;
  turnsByThread.set(threadId, { submitAt: nowMs() });
  timingLog('submit thread=%s', threadId);
}

/**
 * Record first visible output for `threadId` and emit `chat_turn_ttft`. Safe to
 * call on every delta — only the first call per turn takes effect.
 */
export function markChatFirstToken(threadId: string): void {
  const turn = turnsByThread.get(threadId);
  if (!turn || turn.firstTokenAt !== undefined) return;
  turn.firstTokenAt = nowMs();
  const ttftMs = Math.round(turn.firstTokenAt - turn.submitAt);
  timingLog('ttft thread=%s ttft_ms=%d', threadId, ttftMs);
  trackEvent('chat_turn_ttft', { thread: threadId, ttft_ms: ttftMs });
}

/**
 * Record turn completion for `threadId`, emit `chat_turn_complete` with total
 * latency (and TTFT when one was seen), and clear the turn. Token counts from
 * the `chat_done` event are attached when provided.
 */
export function markChatDone(
  threadId: string,
  tokens?: { inputTokens?: number; outputTokens?: number }
): void {
  const turn = turnsByThread.get(threadId);
  if (!turn) return;
  const totalMs = Math.round(nowMs() - turn.submitAt);
  const params: Record<string, string | number | boolean> = {
    thread: threadId,
    total_ms: totalMs,
    streamed: turn.firstTokenAt !== undefined,
  };
  if (turn.firstTokenAt !== undefined) {
    params.ttft_ms = Math.round(turn.firstTokenAt - turn.submitAt);
  }
  if (typeof tokens?.inputTokens === 'number') params.input_tokens = tokens.inputTokens;
  if (typeof tokens?.outputTokens === 'number') params.output_tokens = tokens.outputTokens;
  timingLog('done thread=%s total_ms=%d', threadId, totalMs);
  trackEvent('chat_turn_complete', params);
  turnsByThread.delete(threadId);
}

/** Test helper: drop all in-flight turn timers. */
export function __resetChatTurnTimingForTest(): void {
  turnsByThread.clear();
}
