import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { trackEvent } from '../services/analytics';
import {
  __resetChatTurnTimingForTest,
  markChatDone,
  markChatFirstToken,
  markChatSubmit,
} from './chatTurnTiming';

vi.mock('../services/analytics', () => ({ trackEvent: vi.fn() }));

const trackEventMock = vi.mocked(trackEvent);

describe('chatTurnTiming', () => {
  let now = 0;

  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    trackEventMock.mockClear();
    __resetChatTurnTimingForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits chat_turn_ttft once on the first visible token', () => {
    markChatSubmit('t1');
    now = 1350;
    markChatFirstToken('t1');
    now = 1500;
    markChatFirstToken('t1'); // duplicate — ignored

    expect(trackEventMock).toHaveBeenCalledTimes(1);
    expect(trackEventMock).toHaveBeenCalledWith('chat_turn_ttft', { thread: 't1', ttft_ms: 350 });
  });

  it('emits chat_turn_complete with total, ttft, and token counts', () => {
    markChatSubmit('t1');
    now = 1200;
    markChatFirstToken('t1');
    now = 4200;
    markChatDone('t1', { inputTokens: 42, outputTokens: 99 });

    expect(trackEventMock).toHaveBeenLastCalledWith('chat_turn_complete', {
      thread: 't1',
      total_ms: 3200,
      streamed: true,
      ttft_ms: 200,
      input_tokens: 42,
      output_tokens: 99,
    });
  });

  it('marks streamed=false and omits ttft when no token arrived', () => {
    markChatSubmit('t1');
    now = 2000;
    markChatDone('t1');

    expect(trackEventMock).toHaveBeenCalledWith('chat_turn_complete', {
      thread: 't1',
      total_ms: 1000,
      streamed: false,
    });
  });

  it('ignores first-token and done events for unknown threads', () => {
    markChatFirstToken('ghost');
    markChatDone('ghost');
    expect(trackEventMock).not.toHaveBeenCalled();
  });

  it('clears state on done so a re-used thread id starts fresh', () => {
    markChatSubmit('t1');
    now = 1100;
    markChatDone('t1');
    trackEventMock.mockClear();

    // Second token for the completed turn must not re-emit.
    markChatFirstToken('t1');
    expect(trackEventMock).not.toHaveBeenCalled();
  });

  it('ignores empty thread ids on submit', () => {
    markChatSubmit('');
    markChatFirstToken('');
    expect(trackEventMock).not.toHaveBeenCalled();
  });
});
