//! JSON-RPC handlers for the `meet_agent` domain.
//!
//! Four endpoints, all keyed by `request_id`:
//!
//! - `start_session`     — open a session (idempotent restart on dup id)
//! - `push_listen_pcm`   — feed PCM frames in; may trigger a brain turn
//! - `poll_speech`       — pull synthesized PCM out
//! - `stop_session`      — close + return summary counters
//!
//! Each handler is intentionally short — heavy lifting lives in
//! `session.rs` (state) and `brain.rs` (behavior). RPC code is
//! deserialize-validate-dispatch only.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Map, Value};

use crate::rpc::RpcOutcome;

use super::brain;
use super::ops::VadEvent;
use super::session::registry;
use super::types::{
    PollSpeechRequest, PushCaptionRequest, PushListenPcmRequest, StartSessionRequest,
    StopSessionRequest,
};

const LOG_PREFIX: &str = "[meet-agent-rpc]";

pub async fn handle_start_session(params: Map<String, Value>) -> Result<Value, String> {
    let req: StartSessionRequest = serde_json::from_value(Value::Object(params))
        .map_err(|e| format!("{LOG_PREFIX} invalid start_session params: {e}"))?;

    registry().start(&req.request_id, req.sample_rate_hz)?;
    // Install the call-owner identity before any captions can arrive.
    // The session is created with empty identities — which deliberately
    // fails closed in note_caption — so racing a push_caption against
    // this with_session call would simply drop the early caption rather
    // than leak it. Done as a second step (vs threading through
    // `start`) so the registry's start signature stays unchanged and
    // existing callers (legacy shell variants, smoke tests) don't have
    // to be updated in lockstep.
    registry().with_session(&req.request_id, |s| {
        s.set_identities(&req.owner_display_name, &req.bot_display_name);
    })?;
    log::info!(
        "{LOG_PREFIX} start_session request_id={} sample_rate_hz={} \
         owner_chars={} bot_chars={}",
        req.request_id,
        req.sample_rate_hz,
        req.owner_display_name.chars().count(),
        req.bot_display_name.chars().count()
    );

    RpcOutcome::new(
        json!({
            "ok": true,
            "request_id": req.request_id,
            "sample_rate_hz": req.sample_rate_hz,
        }),
        vec![],
    )
    .into_cli_compatible_json()
}

pub async fn handle_push_listen_pcm(params: Map<String, Value>) -> Result<Value, String> {
    let req: PushListenPcmRequest = serde_json::from_value(Value::Object(params))
        .map_err(|e| format!("{LOG_PREFIX} invalid push_listen_pcm params: {e}"))?;

    let samples =
        decode_pcm16le_b64(&req.pcm_base64).map_err(|e| format!("{LOG_PREFIX} pcm decode: {e}"))?;

    let event = registry().with_session(&req.request_id, |s| s.push_inbound_pcm(&samples))?;

    let turn_started = matches!(event, VadEvent::EndOfUtterance);
    if turn_started {
        // Spawn the turn so the RPC reply doesn't have to wait for STT
        // + TTS to finish — the shell will drain audio via poll_speech.
        let request_id = req.request_id.clone();
        tokio::spawn(async move {
            if let Err(err) = brain::run_turn(&request_id).await {
                log::warn!("{LOG_PREFIX} brain turn failed request_id={request_id} err={err}");
            }
        });
    }

    RpcOutcome::new(
        json!({
            "ok": true,
            "turn_started": turn_started,
        }),
        vec![],
    )
    .into_cli_compatible_json()
}

pub async fn handle_push_caption(params: Map<String, Value>) -> Result<Value, String> {
    let req: PushCaptionRequest = serde_json::from_value(Value::Object(params))
        .map_err(|e| format!("{LOG_PREFIX} invalid push_caption params: {e}"))?;

    // Diagnostic: log the caption text + match outcome so we can tell
    // from the dev:app stdout exactly what the wake-word matcher saw.
    // Truncate to 120 chars to avoid blowing up the log line. This is
    // safe to leave on for now — captions are already broadcast to all
    // participants in the meeting; nothing here that isn't on the wire.
    let preview: String = req.text.chars().take(120).collect();
    let wake_fired = registry().with_session(&req.request_id, |s| {
        s.note_caption(&req.speaker, &req.text, req.ts_ms)
    })?;
    log::info!(
        "{LOG_PREFIX} push_caption request_id={} speaker={} text=\"{}\" wake_fired={}",
        req.request_id,
        req.speaker,
        preview,
        wake_fired,
    );

    if wake_fired {
        log::info!(
            "{LOG_PREFIX} wake word fired request_id={} speaker={}",
            req.request_id,
            req.speaker
        );
        let request_id = req.request_id.clone();
        tokio::spawn(async move {
            if let Err(err) = brain::run_caption_turn(&request_id).await {
                log::warn!("{LOG_PREFIX} caption-turn failed request_id={request_id} err={err}");
            }
        });
    }

    RpcOutcome::new(
        json!({
            "ok": true,
            "turn_started": wake_fired,
        }),
        vec![],
    )
    .into_cli_compatible_json()
}

pub async fn handle_poll_speech(params: Map<String, Value>) -> Result<Value, String> {
    let req: PollSpeechRequest = serde_json::from_value(Value::Object(params))
        .map_err(|e| format!("{LOG_PREFIX} invalid poll_speech params: {e}"))?;

    let (pcm_base64, utterance_done, flush_pending) =
        registry().with_session(&req.request_id, |s| {
            let (b64, done) = s.poll_outbound();
            let flush = s.take_flush_pending();
            (b64, done, flush)
        })?;

    RpcOutcome::new(
        json!({
            "ok": true,
            "pcm_base64": pcm_base64,
            "utterance_done": utterance_done,
            "flush_pending": flush_pending,
        }),
        vec![],
    )
    .into_cli_compatible_json()
}

pub async fn handle_stop_session(params: Map<String, Value>) -> Result<Value, String> {
    let req: StopSessionRequest = serde_json::from_value(Value::Object(params))
        .map_err(|e| format!("{LOG_PREFIX} invalid stop_session params: {e}"))?;

    let session = registry().stop(&req.request_id)?;
    // Drop the cached orchestrator Agent for this meet so we don't
    // leak its memory tree + tool registry handles after the call
    // ends. The next start_session with the same request_id (rare
    // but possible) will cold-build a fresh Agent.
    super::brain::forget_session_agent(&req.request_id).await;
    log::info!(
        "{LOG_PREFIX} stop_session request_id={} listened={:.2}s spoken={:.2}s turns={}",
        session.request_id,
        session.listened_seconds(),
        session.spoken_seconds(),
        session.turn_count
    );

    RpcOutcome::new(
        json!({
            "ok": true,
            "request_id": session.request_id,
            "listened_seconds": session.listened_seconds(),
            "spoken_seconds": session.spoken_seconds(),
            "turn_count": session.turn_count,
        }),
        vec![],
    )
    .into_cli_compatible_json()
}

/// Decode a base64 string of PCM16LE bytes into samples. Empty input is
/// a "heartbeat" push (no audio this tick) and yields an empty Vec.
fn decode_pcm16le_b64(b64: &str) -> Result<Vec<i16>, String> {
    if b64.is_empty() {
        return Ok(Vec::new());
    }
    let bytes = B64
        .decode(b64.as_bytes())
        .map_err(|e| format!("base64: {e}"))?;
    if !bytes.len().is_multiple_of(2) {
        return Err(format!("odd byte length {}", bytes.len()));
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64_pcm(samples: &[i16]) -> String {
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        B64.encode(bytes)
    }

    #[tokio::test]
    async fn start_then_stop_round_trip() {
        let mut params = Map::new();
        params.insert("request_id".into(), json!("rpc-roundtrip"));
        params.insert("sample_rate_hz".into(), json!(16_000));
        let out = handle_start_session(params).await.unwrap();
        assert_eq!(out.get("ok"), Some(&json!(true)));

        let mut stop = Map::new();
        stop.insert("request_id".into(), json!("rpc-roundtrip"));
        let out = handle_stop_session(stop).await.unwrap();
        assert_eq!(out.get("turn_count"), Some(&json!(0)));
    }

    #[tokio::test]
    async fn push_then_poll_returns_audio_after_brain_turn() {
        let mut start = Map::new();
        start.insert("request_id".into(), json!("rpc-push"));
        start.insert("sample_rate_hz".into(), json!(16_000));
        handle_start_session(start).await.unwrap();

        // Push a loud frame, then enough silent frames to cross the
        // VAD hangover and trigger a turn.
        let loud: Vec<i16> = (0..1600)
            .map(|i| if i % 2 == 0 { 8000i16 } else { -8000 })
            .collect();
        let mut p = Map::new();
        p.insert("request_id".into(), json!("rpc-push"));
        p.insert("pcm_base64".into(), json!(b64_pcm(&loud)));
        handle_push_listen_pcm(p).await.unwrap();

        // ~1s of speech-like content so the brain turn doesn't skip.
        for _ in 0..10 {
            let mut p = Map::new();
            p.insert("request_id".into(), json!("rpc-push"));
            p.insert("pcm_base64".into(), json!(b64_pcm(&loud)));
            handle_push_listen_pcm(p).await.unwrap();
        }

        // Now silence frames to trigger end-of-utterance.
        let silence = vec![0i16; 1600];
        let mut last = json!(false);
        for _ in 0..10 {
            let mut p = Map::new();
            p.insert("request_id".into(), json!("rpc-push"));
            p.insert("pcm_base64".into(), json!(b64_pcm(&silence)));
            let out = handle_push_listen_pcm(p).await.unwrap();
            if out.get("turn_started") == Some(&json!(true)) {
                last = json!(true);
                break;
            }
        }
        assert_eq!(last, json!(true), "expected a turn_started=true reply");

        // Wait up to 30s for the spawned brain turn to enqueue audio.
        // The agentic path builds an orchestrator Agent on first wake
        // (memory tree load + MCP init), which can take several seconds
        // even in a minimal test environment. Failing the agentic path
        // (no backend token) still falls through to a canned-ack TTS
        // stub, so the queue eventually fills regardless. Poll every
        // 100ms so the test exits the moment audio lands.
        let mut pcm = String::new();
        for _ in 0..300 {
            let mut poll = Map::new();
            poll.insert("request_id".into(), json!("rpc-push"));
            let out = handle_poll_speech(poll).await.unwrap();
            let chunk = out.get("pcm_base64").and_then(|v| v.as_str()).unwrap_or("");
            if !chunk.is_empty() {
                pcm = chunk.to_string();
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(!pcm.is_empty(), "expected synthesized audio after turn");

        let mut stop = Map::new();
        stop.insert("request_id".into(), json!("rpc-push"));
        handle_stop_session(stop).await.unwrap();
    }

    #[test]
    fn decode_pcm16le_b64_handles_empty() {
        assert!(decode_pcm16le_b64("").unwrap().is_empty());
    }

    #[test]
    fn decode_pcm16le_b64_rejects_odd_length() {
        // Three bytes -> odd number of bytes -> reject.
        let odd = B64.encode([0u8, 1, 2]);
        assert!(decode_pcm16le_b64(&odd).is_err());
    }
}
