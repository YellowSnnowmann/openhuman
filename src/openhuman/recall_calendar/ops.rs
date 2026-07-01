//! Business logic for the `recall_calendar` domain.
//!
//! The core never talks to Recall.ai directly — every call proxies to the
//! openhuman backend's `/agent-integrations/recall-calendar/*` routes through
//! the shared [`IntegrationClient`], which attaches the app-session JWT and
//! unwraps the `{ success, data }` envelope (including 401 → session-expiry
//! handling). This mirrors the Composio domain's backend-proxied design.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::openhuman::config::Config;
use crate::openhuman::integrations::client::IntegrationClient;
use crate::rpc::RpcOutcome;

use super::types::{
    RecallCalendarConnect, RecallCalendarDisconnect, RecallCalendarStatus, RecallMeeting,
    RecallMeetingsResponse,
};

const CONNECT_PATH: &str = "/agent-integrations/recall-calendar/connect";
const STATUS_PATH: &str = "/agent-integrations/recall-calendar/status";
const DISCONNECT_PATH: &str = "/agent-integrations/recall-calendar/disconnect";
const MEETINGS_PATH: &str = "/agent-integrations/recall-calendar/meetings";

fn recall_client(config: &Config) -> Result<Arc<IntegrationClient>, String> {
    crate::openhuman::integrations::build_client(config)
        .ok_or_else(|| "[recall_calendar] backend client unavailable (no session)".to_string())
}

/// Start the Recall Calendar V1 OAuth flow; returns the Google consent URL.
pub async fn connect(config: &Config) -> Result<RpcOutcome<RecallCalendarConnect>, String> {
    tracing::debug!("[recall_calendar] rpc connect");
    let client = recall_client(config)?;
    let resp = client
        .post::<RecallCalendarConnect>(CONNECT_PATH, &json!({}))
        .await
        .map_err(|e| format!("[recall_calendar] connect failed: {e:#}"))?;
    Ok(RpcOutcome::new(
        resp,
        vec!["recall_calendar: connect flow started".to_string()],
    ))
}

/// Fetch the user's Recall calendar connection status.
pub async fn status(config: &Config) -> Result<RpcOutcome<RecallCalendarStatus>, String> {
    tracing::debug!("[recall_calendar] rpc status");
    let client = recall_client(config)?;
    let resp = client
        .get::<RecallCalendarStatus>(STATUS_PATH)
        .await
        .map_err(|e| format!("[recall_calendar] status failed: {e:#}"))?;
    Ok(RpcOutcome::new(resp, Vec::new()))
}

/// Return whether Recall Calendar is both enabled server-side and connected for
/// the current backend user. This is used by core meeting fetch paths that
/// should not depend on the settings UI being mounted long enough to sync the
/// local `meet.calendar_provider` flag.
pub async fn is_connected(config: &Config) -> Result<bool, String> {
    let outcome = status(config).await?;
    Ok(outcome.value.enabled && outcome.value.connected)
}

/// Disconnect the user's Google calendar from Recall.
pub async fn disconnect(config: &Config) -> Result<RpcOutcome<RecallCalendarDisconnect>, String> {
    tracing::debug!("[recall_calendar] rpc disconnect");
    let client = recall_client(config)?;
    let resp = client
        .post::<RecallCalendarDisconnect>(DISCONNECT_PATH, &json!({}))
        .await
        .map_err(|e| format!("[recall_calendar] disconnect failed: {e:#}"))?;
    Ok(RpcOutcome::new(
        resp,
        vec!["recall_calendar: calendar disconnected".to_string()],
    ))
}

/// Fetch upcoming meetings from the connected calendar (raw list).
pub async fn fetch_recall_meetings(config: &Config) -> Result<Vec<RecallMeeting>, String> {
    let client = recall_client(config)?;
    let resp = client
        .get::<RecallMeetingsResponse>(MEETINGS_PATH)
        .await
        .map_err(|e| format!("[recall_calendar] list meetings failed: {e:#}"))?;
    Ok(resp.meetings)
}

/// RPC wrapper around [`fetch_recall_meetings`].
pub async fn list_meetings(config: &Config) -> Result<RpcOutcome<RecallMeetingsResponse>, String> {
    tracing::debug!("[recall_calendar] rpc list_meetings");
    let meetings = fetch_recall_meetings(config).await?;
    let count = meetings.len();
    Ok(RpcOutcome::new(
        RecallMeetingsResponse { meetings },
        vec![format!("recall_calendar: {count} upcoming meeting(s)")],
    ))
}

/// Reshape backend-normalized Recall meetings into a Google-Calendar
/// `events.list`-style payload so the existing calendar extractors
/// (`agent_meetings::upcoming::extract_upcoming_meetings` and
/// `heartbeat::planner::collectors::extract_calendar_events`) parse them
/// unchanged. Only meetings with both a join URL and a start time survive.
pub fn meetings_to_gcal_json(meetings: &[RecallMeeting]) -> Value {
    let items: Vec<Value> = meetings
        .iter()
        .filter_map(|m| {
            let url = m
                .meeting_url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())?;
            let start = m
                .start_time
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())?;
            let mut item = json!({
                "id": m.id,
                "summary": m.title.clone().unwrap_or_else(|| "Meeting".to_string()),
                "start": { "dateTime": start },
                "hangoutLink": url,
                "htmlLink": url,
            });
            if let Some(end) = m
                .end_time
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                item["end"] = json!({ "dateTime": end });
            }
            Some(item)
        })
        .collect();
    json!({ "items": items })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meeting(id: &str, url: Option<&str>, start: Option<&str>) -> RecallMeeting {
        RecallMeeting {
            id: id.to_string(),
            title: Some("Standup".to_string()),
            meeting_url: url.map(ToString::to_string),
            start_time: start.map(ToString::to_string),
            end_time: Some("2026-07-01T10:30:00Z".to_string()),
            platform: Some("google_meet".to_string()),
            bot_id: None,
        }
    }

    #[test]
    fn maps_fields_into_gcal_shape() {
        let m = meeting(
            "evt-1",
            Some("https://meet.google.com/abc"),
            Some("2026-07-01T10:00:00Z"),
        );
        let json = meetings_to_gcal_json(&[m]);
        let items = json["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        let it = &items[0];
        assert_eq!(it["id"], "evt-1");
        assert_eq!(it["summary"], "Standup");
        assert_eq!(it["start"]["dateTime"], "2026-07-01T10:00:00Z");
        assert_eq!(it["end"]["dateTime"], "2026-07-01T10:30:00Z");
        assert_eq!(it["hangoutLink"], "https://meet.google.com/abc");
    }

    #[test]
    fn drops_meetings_without_url_or_start() {
        let items = meetings_to_gcal_json(&[
            meeting("no-url", None, Some("2026-07-01T10:00:00Z")),
            meeting("no-start", Some("https://meet.google.com/x"), None),
            meeting("blank-url", Some("   "), Some("2026-07-01T10:00:00Z")),
        ]);
        assert_eq!(items["items"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn defaults_missing_title() {
        let mut m = meeting(
            "evt-2",
            Some("https://meet.google.com/y"),
            Some("2026-07-01T10:00:00Z"),
        );
        m.title = None;
        let json = meetings_to_gcal_json(&[m]);
        assert_eq!(json["items"][0]["summary"], "Meeting");
    }
}
