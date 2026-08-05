//! Realtime voice-agent session bootstrap — mints a short-lived signed
//! WebSocket URL from the hosted backend's `/voice-agent/get-signed-url`
//! endpoint so the desktop client can open an ElevenLabs Agents
//! (Conversational AI) session directly. The provider API key stays
//! server-side; the client only ever sees the signed URL (#5399).
//!
//! Approval gate (#1339) classification: **internal** — the user's own
//! assistant listening/speaking through the user's own mic/speakers, with no
//! third-party outbound effect.

use log::debug;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::config::effective_backend_api_url;
use crate::api::jwt::get_session_token;
use crate::api::BackendOAuthClient;
use crate::openhuman::config::Config;
use crate::rpc::RpcOutcome;

const LOG_PREFIX: &str = "[voice-realtime]";

/// A short-lived signed URL for a realtime voice-agent session plus the agent
/// it was minted for. Mirrors the backend `/voice-agent/get-signed-url` shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceAgentSignedUrl {
    pub signed_url: String,
    pub agent_id: String,
}

/// Mint a realtime voice-agent signed URL by proxying the hosted backend.
///
/// Follows the `reply_speech::synthesize_reply` auth pattern: session token →
/// [`BackendOAuthClient`] → `authed_json`, with `flatten_authed_error` so a
/// lapsed-session 401 classifies as `SESSION_EXPIRED` and skips Sentry rather
/// than leaking as a raw error string.
pub async fn mint_voice_agent_signed_url(
    config: &Config,
) -> Result<RpcOutcome<VoiceAgentSignedUrl>, String> {
    let token = get_session_token(config)
        .map_err(|e| e.to_string())?
        .and_then(|t| {
            let s = t.trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        })
        .ok_or_else(|| "no backend session token; sign in first".to_string())?;

    let api_url = effective_backend_api_url(&config.api_url);
    let client = BackendOAuthClient::new(&api_url).map_err(|e| e.to_string())?;

    let raw = client
        .authed_json(&token, Method::GET, "/voice-agent/get-signed-url", None)
        .await
        .map_err(crate::api::flatten_authed_error)?;

    let result = parse_signed_url_response(&raw)?;
    debug!("{LOG_PREFIX} minted signed url agent={}", result.agent_id);
    Ok(RpcOutcome::single_log(
        result,
        "voice agent signed url minted via GET /voice-agent/get-signed-url",
    ))
}

/// Translate the backend's `{ success, data: { signedUrl, agentId } }` envelope
/// (or a bare object) into the UI contract. Kept separate so the parsing is
/// unit-testable without a live backend.
fn parse_signed_url_response(raw: &Value) -> Result<VoiceAgentSignedUrl, String> {
    let data = raw.get("data").unwrap_or(raw);
    let signed_url = data
        .get("signedUrl")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let agent_id = data
        .get("agentId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if signed_url.is_empty() {
        return Err("backend returned no signed_url for the voice agent".to_string());
    }
    Ok(VoiceAgentSignedUrl {
        signed_url,
        agent_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_the_wrapped_success_envelope() {
        let raw = json!({ "success": true, "data": { "signedUrl": "wss://x", "agentId": "a1" } });
        let out = parse_signed_url_response(&raw).unwrap();
        assert_eq!(out.signed_url, "wss://x");
        assert_eq!(out.agent_id, "a1");
    }

    #[test]
    fn tolerates_a_bare_object() {
        let raw = json!({ "signedUrl": "wss://y", "agentId": "a2" });
        let out = parse_signed_url_response(&raw).unwrap();
        assert_eq!(out.signed_url, "wss://y");
        assert_eq!(out.agent_id, "a2");
    }

    #[test]
    fn errors_when_signed_url_is_absent() {
        let raw = json!({ "data": { "agentId": "a3" } });
        let err = parse_signed_url_response(&raw).unwrap_err();
        assert!(err.contains("no signed_url"), "{err}");
    }

    #[test]
    fn result_serializes_snake_case_for_the_wire() {
        let json = serde_json::to_value(VoiceAgentSignedUrl {
            signed_url: "wss://z".into(),
            agent_id: "a4".into(),
        })
        .unwrap();
        assert_eq!(json.get("signed_url").unwrap(), "wss://z");
        assert_eq!(json.get("agent_id").unwrap(), "a4");
    }
}
