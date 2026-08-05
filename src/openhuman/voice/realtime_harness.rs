//! Realtime voice-agent turn handler (#5399).
//!
//! The backend relays each turn of an ElevenLabs Agents session down the socket
//! as `voice:harness { correlationId, messages }` (see the backend's
//! `/voice-agent/chat/completions` Custom-LLM relay). We run the **local
//! orchestrator agent** — the same brain the chat UI and meet bot use, with the
//! user's tools/memory/MCP — and stream the reply back up as
//! `voice:harness:delta` / `voice:harness:done` (or `:error`). This is what
//! keeps a cloud realtime voice session backed by the desktop-local brain.
//!
//! Approval-gate origin: **ExternalChannel** — the turn text is user speech
//! arriving over a channel, so `external_effect` tools route through the
//! audit-trail path rather than running with trusted-CLI semantics.

use std::time::Duration;

use log::{info, warn};
use serde_json::{json, Value};

use crate::openhuman::agent::harness::session::Agent;
use crate::openhuman::agent::turn_origin::{with_origin, AgentTurnOrigin};
use crate::openhuman::platform::socket::manager::global_socket_manager;

const TURN_TIMEOUT_SECS: u64 = 90;

/// Spoken-output directive appended to the orchestrator profile so replies read
/// naturally through TTS instead of as markdown.
const VOICE_DIRECTIVE: &str = "You are speaking aloud in a live voice conversation. \
Reply in natural, concise spoken sentences. Do not use markdown, code blocks, \
bullet lists, headings, or emoji.";

/// Extract the user prompt from an OpenAI-style `messages` array: the content of
/// the last `user` message. Content may be a plain string or an array of
/// `{ type: 'text', text }` parts (multimodal shape). Pure + unit-tested.
pub fn extract_prompt(messages: &[Value]) -> String {
    for msg in messages.iter().rev() {
        if msg.get("role").and_then(Value::as_str) == Some("user") {
            return content_to_text(msg.get("content"));
        }
    }
    String::new()
}

fn content_to_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// Handle one relayed voice turn end to end: run the orchestrator and emit the
/// reply back up the socket. Never panics — every failure path emits
/// `voice:harness:error` so the backend relay ends the turn cleanly.
pub async fn handle_voice_harness_turn(correlation_id: String, messages: Vec<Value>) {
    let prompt = extract_prompt(&messages);
    if prompt.trim().is_empty() {
        emit_error(&correlation_id, "no user message in the relayed turn").await;
        return;
    }

    match run_agent_turn(&correlation_id, &prompt).await {
        Ok(reply) => {
            let spoken = reply.trim();
            if !spoken.is_empty() {
                emit_event(
                    "voice:harness:delta",
                    json!({ "correlationId": correlation_id, "text": spoken }),
                )
                .await;
            }
            emit_event(
                "voice:harness:done",
                json!({ "correlationId": correlation_id }),
            )
            .await;
        }
        Err(err) => {
            warn!("[voice-harness] turn failed correlation={correlation_id}: {err}");
            emit_error(&correlation_id, &err).await;
        }
    }
}

async fn run_agent_turn(correlation_id: &str, prompt: &str) -> Result<String, String> {
    let config = crate::openhuman::config::ops::load_config_with_timeout().await?;
    let mut agent = Agent::from_config_for_agent_with_profile(
        &config,
        "orchestrator",
        None,
        Some(VOICE_DIRECTIVE.to_string()),
        None,
    )
    .map_err(|e| format!("orchestrator build failed: {e}"))?;
    agent.set_event_context(format!("voice_{correlation_id}"), "voice_agent");

    info!(
        "[voice-harness] orchestrator turn correlation={correlation_id} prompt_chars={}",
        prompt.chars().count()
    );

    let fut = with_origin(
        AgentTurnOrigin::ExternalChannel {
            channel: "voice".to_string(),
            sender: None,
            reply_target: correlation_id.to_string(),
            message_id: format!("voice-{correlation_id}"),
        },
        agent.run_single(prompt),
    );

    match tokio::time::timeout(Duration::from_secs(TURN_TIMEOUT_SECS), fut).await {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(e)) => Err(format!("orchestrator run_single failed: {e}")),
        Err(_) => Err(format!(
            "orchestrator turn timed out after {TURN_TIMEOUT_SECS}s"
        )),
    }
}

async fn emit_event(event: &str, payload: Value) {
    match global_socket_manager() {
        Some(mgr) => {
            if let Err(e) = mgr.emit(event, payload).await {
                warn!("[voice-harness] emit {event} failed: {e}");
            }
        }
        None => warn!("[voice-harness] no socket manager; dropping {event}"),
    }
}

async fn emit_error(correlation_id: &str, message: &str) {
    emit_event(
        "voice:harness:error",
        json!({ "correlationId": correlation_id, "message": message }),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_the_last_user_string_message() {
        let messages = vec![
            json!({ "role": "system", "content": "be nice" }),
            json!({ "role": "user", "content": "first" }),
            json!({ "role": "assistant", "content": "ok" }),
            json!({ "role": "user", "content": "what is the weather" }),
        ];
        assert_eq!(extract_prompt(&messages), "what is the weather");
    }

    #[test]
    fn joins_multimodal_text_parts() {
        let messages = vec![json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "hello" },
                { "type": "text", "text": "there" },
            ],
        })];
        assert_eq!(extract_prompt(&messages), "hello there");
    }

    #[test]
    fn returns_empty_when_no_user_message() {
        let messages = vec![json!({ "role": "assistant", "content": "hi" })];
        assert_eq!(extract_prompt(&messages), "");
        assert_eq!(extract_prompt(&[]), "");
    }
}
