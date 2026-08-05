import { useConversation } from '@elevenlabs/react';
import { useCallback, useRef, useState } from 'react';

import { fetchVoiceAgentSignedUrl } from '../../../services/api/voiceAgentApi';
import { MASCOT_VOICE_ID } from '../../../utils/config';

/**
 * Lifecycle of a realtime ElevenLabs Agents voice session (#5399).
 * `idle → connecting → active → idle`, or `→ error`.
 */
export type RealtimeSessionState = 'idle' | 'connecting' | 'active' | 'error';

export interface RealtimeVoiceSession {
  state: RealtimeSessionState;
  /** True while the agent is speaking (drives the mascot's speaking pose). */
  isSpeaking: boolean;
  /** ElevenLabs turn mode; `listening` while the user speaks. */
  mode: 'speaking' | 'listening';
  error: string | null;
  /** Fetch a signed URL and open the WebSocket session. Idempotent while busy. */
  start: () => Promise<void>;
  stop: () => void;
}

/**
 * Drives a realtime voice-agent session with `@elevenlabs/react`. Must be used
 * inside a `ConversationProvider` (see `RealtimeVoiceControls`). Uses the
 * WebSocket connection type so the per-audio-event character `alignment` is
 * available for mascot lip-sync.
 */
export function useRealtimeVoiceSession(opts?: { voiceId?: string }): RealtimeVoiceSession {
  const [state, setState] = useState<RealtimeSessionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const startingRef = useRef(false);

  const conversation = useConversation({
    onConnect: () => setState('active'),
    onDisconnect: () => setState('idle'),
    onError: (message: string) => {
      setError(message);
      setState('error');
    },
  });

  const start = useCallback(async () => {
    if (startingRef.current || state === 'active' || state === 'connecting') return;
    startingRef.current = true;
    setError(null);
    setState('connecting');
    try {
      const { signedUrl } = await fetchVoiceAgentSignedUrl();
      conversation.startSession({
        signedUrl,
        connectionType: 'websocket',
        overrides: { tts: { voiceId: opts?.voiceId ?? MASCOT_VOICE_ID } },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    } finally {
      startingRef.current = false;
    }
  }, [conversation, opts?.voiceId, state]);

  const stop = useCallback(() => {
    conversation.endSession();
    setState('idle');
  }, [conversation]);

  return {
    state,
    isSpeaking: conversation.isSpeaking,
    mode: conversation.mode,
    error,
    start,
    stop,
  };
}
