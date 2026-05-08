use std::collections::HashSet;

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::core::event_bus::{publish_global, DomainEvent};
use crate::openhuman::composio::build_composio_client;
use crate::openhuman::config::Config;
use crate::openhuman::cron;
use crate::openhuman::notifications::bus::publish_core_notification;
use crate::openhuman::notifications::store as notifications_store;
use crate::openhuman::notifications::types::{
    CoreNotificationCategory, CoreNotificationEvent, IntegrationNotification, NotificationStatus,
};

mod store;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeartbeatCategory {
    Meetings,
    Reminders,
    Important,
}

impl HeartbeatCategory {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Meetings => "meetings",
            Self::Reminders => "reminders",
            Self::Important => "important",
        }
    }

    fn notification_category(&self) -> CoreNotificationCategory {
        match self {
            Self::Meetings => CoreNotificationCategory::Meetings,
            Self::Reminders => CoreNotificationCategory::Reminders,
            Self::Important => CoreNotificationCategory::Important,
        }
    }
}

#[derive(Debug, Clone)]
struct PendingEvent {
    category: HeartbeatCategory,
    source: String,
    source_event_id: String,
    fingerprint: String,
    title: String,
    body: String,
    deep_link: Option<String>,
    anchor_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct PlannedDelivery {
    stage: &'static str,
    title: String,
    body: String,
    proactive_message: String,
    allow_external: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlannerRunSummary {
    pub source_events: usize,
    pub deliveries_attempted: usize,
    pub deliveries_sent: usize,
    pub deliveries_skipped_dedup: usize,
}

impl PlannerRunSummary {
    fn empty() -> Self {
        Self {
            source_events: 0,
            deliveries_attempted: 0,
            deliveries_sent: 0,
            deliveries_skipped_dedup: 0,
        }
    }
}

pub async fn evaluate_and_dispatch(config: &Config, now: DateTime<Utc>) -> PlannerRunSummary {
    let mut summary = PlannerRunSummary::empty();

    if !(config.heartbeat.notify_meetings
        || config.heartbeat.notify_reminders
        || config.heartbeat.notify_relevant_events)
    {
        tracing::debug!("[heartbeat:planner] all categories disabled; skipping tick");
        return summary;
    }

    let mut events = Vec::new();

    if config.heartbeat.notify_reminders {
        events.extend(collect_cron_reminders(config, now));
    }

    if config.heartbeat.notify_meetings {
        events.extend(collect_calendar_meetings(config, now).await);
    }

    if config.heartbeat.notify_relevant_events {
        events.extend(collect_relevant_notifications(config, now));
    }

    summary.source_events = events.len();

    let mut seen_keys: HashSet<String> = HashSet::new();

    for event in events {
        let Some(plan) = plan_delivery_for_event(&event, config, now) else {
            continue;
        };

        let dedupe_key = stable_key(&format!(
            "{}|{}|{}",
            event.category.as_str(),
            event.fingerprint,
            plan.stage
        ));

        // Overlapping sources in the same tick should still dedupe before hitting disk.
        if !seen_keys.insert(dedupe_key.clone()) {
            summary.deliveries_skipped_dedup += 1;
            continue;
        }

        summary.deliveries_attempted += 1;

        let inserted = match store::mark_sent(
            config,
            &store::SentMarker {
                dedupe_key: &dedupe_key,
                event_fingerprint: &event.fingerprint,
                source: &event.source,
                category: event.category.as_str(),
                stage: plan.stage,
                sent_at: now,
            },
        ) {
            Ok(v) => v,
            Err(error) => {
                tracing::warn!(
                    dedupe_key = %dedupe_key,
                    source = %event.source,
                    source_event_id = %event.source_event_id,
                    category = event.category.as_str(),
                    error = %error,
                    "[heartbeat:planner] failed to persist dedupe marker"
                );
                continue;
            }
        };

        if !inserted {
            summary.deliveries_skipped_dedup += 1;
            continue;
        }

        let id = format!(
            "heartbeat:{}:{}:{}",
            event.category.as_str(),
            plan.stage,
            &dedupe_key[..12]
        );

        persist_heartbeat_alert(config, &event, &plan, now);
        publish_core_notification(CoreNotificationEvent {
            id,
            category: event.category.notification_category(),
            title: plan.title,
            body: plan.body,
            deep_link: event.deep_link.clone(),
            timestamp_ms: now.timestamp_millis().max(0) as u64,
        });

        if config.heartbeat.external_delivery_enabled && plan.allow_external {
            publish_global(DomainEvent::ProactiveMessageRequested {
                source: format!("heartbeat:{}", event.category.as_str()),
                message: plan.proactive_message,
                job_name: Some(format!("heartbeat-{}", event.category.as_str())),
            });
        }

        summary.deliveries_sent += 1;

        tracing::debug!(
            dedupe_key = %dedupe_key,
            source = %event.source,
            source_event_id = %event.source_event_id,
            category = event.category.as_str(),
            stage = plan.stage,
            "[heartbeat:planner] delivery sent"
        );
    }

    if let Err(error) = store::prune_old(config, now - Duration::days(14)) {
        tracing::warn!(error = %error, "[heartbeat:planner] prune_old failed");
    }

    summary
}

fn collect_cron_reminders(config: &Config, now: DateTime<Utc>) -> Vec<PendingEvent> {
    let lookahead = Duration::minutes(i64::from(
        config.heartbeat.reminder_lookahead_minutes.max(1),
    ));

    let jobs = match cron::list_jobs(config) {
        Ok(jobs) => jobs,
        Err(error) => {
            tracing::warn!(error = %error, "[heartbeat:planner] cron list_jobs failed");
            return Vec::new();
        }
    };

    jobs.into_iter()
        .filter(|job| job.enabled)
        .filter(|job| is_reminder_like_job(job))
        .filter(|job| {
            let delta = job.next_run.signed_duration_since(now);
            delta <= lookahead && delta >= Duration::minutes(-2)
        })
        .map(|job| {
            let title = job
                .name
                .clone()
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| "Reminder".to_string());
            let fingerprint = stable_key(&format!("cron:{}:{}", job.id, job.next_run.to_rfc3339()));
            let body = format!(
                "{} is scheduled at {}.",
                title,
                job.next_run.format("%H:%M")
            );

            PendingEvent {
                category: HeartbeatCategory::Reminders,
                source: "cron".to_string(),
                source_event_id: job.id,
                fingerprint,
                title,
                body,
                deep_link: Some("/settings/cron-jobs".to_string()),
                anchor_at: job.next_run,
            }
        })
        .collect()
}

fn is_reminder_like_job(job: &cron::CronJob) -> bool {
    if job.delivery.mode.eq_ignore_ascii_case("proactive") {
        return true;
    }

    let mut haystack = String::new();
    if let Some(name) = &job.name {
        haystack.push_str(name);
        haystack.push(' ');
    }
    if let Some(prompt) = &job.prompt {
        haystack.push_str(prompt);
        haystack.push(' ');
    }
    haystack.push_str(&job.command);

    let lowered = haystack.to_ascii_lowercase();
    lowered.contains("remind")
        || lowered.contains("meeting")
        || lowered.contains("standup")
        || lowered.contains("follow up")
}

async fn collect_calendar_meetings(config: &Config, now: DateTime<Utc>) -> Vec<PendingEvent> {
    let Some(client) = build_composio_client(config) else {
        return Vec::new();
    };

    let connections = match client.list_connections().await {
        Ok(resp) => resp.connections,
        Err(error) => {
            tracing::warn!(error = %error, "[heartbeat:planner] composio list_connections failed");
            return Vec::new();
        }
    };

    let lookahead = Duration::minutes(i64::from(config.heartbeat.meeting_lookahead_minutes.max(1)));
    let end_window = now + lookahead;

    let mut out = Vec::new();
    for conn in connections.into_iter().filter(|c| c.is_active()) {
        let toolkit = conn.normalized_toolkit();
        if toolkit != "googlecalendar" && toolkit != "google_calendar" && toolkit != "calendar" {
            continue;
        }

        let arguments = json!({
            "connectionId": conn.id,
            "timeMin": now.to_rfc3339(),
            "timeMax": end_window.to_rfc3339(),
            "maxResults": 20
        });

        let resp = match client
            .execute_tool("GOOGLECALENDAR_EVENTS_LIST", Some(arguments))
            .await
        {
            Ok(resp) => resp,
            Err(error) => {
                tracing::warn!(
                    toolkit = %toolkit,
                    connection_id = %conn.id,
                    error = %error,
                    "[heartbeat:planner] GOOGLECALENDAR_EVENTS_LIST failed"
                );
                continue;
            }
        };

        out.extend(extract_calendar_events(
            &resp.data, &toolkit, &conn.id, now, end_window,
        ));
    }

    out
}

fn extract_calendar_events(
    value: &serde_json::Value,
    toolkit: &str,
    connection_id: &str,
    start_window: DateTime<Utc>,
    end_window: DateTime<Utc>,
) -> Vec<PendingEvent> {
    let mut out = Vec::new();
    collect_calendar_events_recursive(
        value,
        toolkit,
        connection_id,
        start_window,
        end_window,
        &mut out,
    );
    out
}

fn collect_calendar_events_recursive(
    value: &serde_json::Value,
    toolkit: &str,
    connection_id: &str,
    start_window: DateTime<Utc>,
    end_window: DateTime<Utc>,
    out: &mut Vec<PendingEvent>,
) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                collect_calendar_events_recursive(
                    item,
                    toolkit,
                    connection_id,
                    start_window,
                    end_window,
                    out,
                );
            }
        }
        serde_json::Value::Object(map) => {
            if let Some(starts_at) = extract_datetime_from_map(map) {
                if starts_at >= start_window && starts_at <= end_window {
                    let title = extract_title_from_map(map);
                    let source_event_id = map
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .or_else(|| map.get("eventId").and_then(serde_json::Value::as_str))
                        .or_else(|| map.get("icalUID").and_then(serde_json::Value::as_str))
                        .unwrap_or("calendar-event")
                        .to_string();
                    let deep_link = map
                        .get("htmlLink")
                        .and_then(serde_json::Value::as_str)
                        .or_else(|| map.get("hangoutLink").and_then(serde_json::Value::as_str))
                        .map(ToString::to_string);

                    let fingerprint = stable_key(&format!(
                        "{}:{}:{}:{}",
                        toolkit,
                        connection_id,
                        source_event_id,
                        starts_at.to_rfc3339()
                    ));

                    out.push(PendingEvent {
                        category: HeartbeatCategory::Meetings,
                        source: format!("calendar:{toolkit}"),
                        source_event_id,
                        fingerprint,
                        title: title.clone(),
                        body: format!("{} starts at {}.", title, starts_at.format("%H:%M")),
                        deep_link,
                        anchor_at: starts_at,
                    });
                }
            }

            for child in map.values() {
                collect_calendar_events_recursive(
                    child,
                    toolkit,
                    connection_id,
                    start_window,
                    end_window,
                    out,
                );
            }
        }
        _ => {}
    }
}

fn extract_datetime_from_map(
    map: &serde_json::Map<String, serde_json::Value>,
) -> Option<DateTime<Utc>> {
    let start = map.get("start").and_then(|start| match start {
        serde_json::Value::Object(start_map) => start_map
            .get("dateTime")
            .and_then(serde_json::Value::as_str)
            .or_else(|| start_map.get("date").and_then(serde_json::Value::as_str)),
        serde_json::Value::String(s) => Some(s.as_str()),
        _ => None,
    });

    let direct = start
        .or_else(|| map.get("start_time").and_then(serde_json::Value::as_str))
        .or_else(|| map.get("startTime").and_then(serde_json::Value::as_str))
        .or_else(|| map.get("starts_at").and_then(serde_json::Value::as_str))
        .or_else(|| map.get("startsAt").and_then(serde_json::Value::as_str));

    direct.and_then(parse_datetime)
}

fn extract_title_from_map(map: &serde_json::Map<String, serde_json::Value>) -> String {
    map.get("summary")
        .and_then(serde_json::Value::as_str)
        .or_else(|| map.get("title").and_then(serde_json::Value::as_str))
        .or_else(|| map.get("name").and_then(serde_json::Value::as_str))
        .map(|raw| sanitize_preview(raw, 80))
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "Upcoming meeting".to_string())
}

fn parse_datetime(raw: &str) -> Option<DateTime<Utc>> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .map(|dt| dt.with_timezone(&Utc))
        .or_else(|_| {
            chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d").map(|date| {
                chrono::DateTime::<Utc>::from_naive_utc_and_offset(
                    date.and_hms_opt(0, 0, 0).unwrap(),
                    Utc,
                )
            })
        })
        .ok()
}

fn collect_relevant_notifications(config: &Config, now: DateTime<Utc>) -> Vec<PendingEvent> {
    let items = match notifications_store::list(config, 100, 0, None, Some(0.8)) {
        Ok(items) => items,
        Err(error) => {
            tracing::warn!(error = %error, "[heartbeat:planner] notifications list failed");
            return Vec::new();
        }
    };

    items
        .into_iter()
        // Never re-escalate notifications we generated ourselves — that creates a
        // feedback loop where each heartbeat tick spawns a new "Important event"
        // with a fresh ID that bypasses the dedupe store.
        .filter(|item| item.provider != "heartbeat")
        .filter(|item| {
            item.status == crate::openhuman::notifications::types::NotificationStatus::Unread
        })
        .filter(|item| {
            item.triage_action
                .as_deref()
                .map(|action| action == "escalate" || action == "react")
                .unwrap_or(false)
                || item
                    .raw_payload
                    .get("urgent")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
        })
        .filter(|item| now.signed_duration_since(item.received_at) <= Duration::minutes(30))
        .map(|item| {
            let title = format!("Important event from {}", item.provider);
            let body = sanitize_preview(&item.title, 100);

            PendingEvent {
                category: HeartbeatCategory::Important,
                source: format!("notification:{}", item.provider),
                source_event_id: item.id.clone(),
                fingerprint: stable_key(&format!("notification:{}", item.id)),
                title,
                body,
                deep_link: Some("/notifications".to_string()),
                anchor_at: item.received_at,
            }
        })
        .collect()
}

fn plan_delivery_for_event(
    event: &PendingEvent,
    config: &Config,
    now: DateTime<Utc>,
) -> Option<PlannedDelivery> {
    let until = event.anchor_at.signed_duration_since(now);
    let until_minutes = until.num_minutes();

    match event.category {
        HeartbeatCategory::Meetings => {
            let lookahead = i64::from(config.heartbeat.meeting_lookahead_minutes.max(1));
            if until_minutes > 10 && until_minutes <= lookahead {
                let mins = until_minutes.max(1);
                return Some(PlannedDelivery {
                    stage: "heads_up",
                    title: format!("Meeting soon: {}", event.title),
                    body: format!("Starts in about {mins} minutes."),
                    proactive_message: format!(
                        "You have a meeting coming up in about {mins} minutes: {}.",
                        event.title
                    ),
                    allow_external: false,
                });
            }
            if until_minutes > 0 && until_minutes <= 10 {
                let mins = until_minutes.max(1);
                return Some(PlannedDelivery {
                    stage: "final_call",
                    title: format!("Upcoming meeting: {}", event.title),
                    body: format!("Starts in about {mins} minutes."),
                    proactive_message: format!(
                        "Your meeting starts in about {mins} minutes: {}.",
                        event.title
                    ),
                    allow_external: true,
                });
            }
            // Wider grace window: heartbeat runs every few minutes, so
            // tiny post-start windows can miss real meetings.
            if until_minutes <= 0 && until_minutes >= -10 {
                return Some(PlannedDelivery {
                    stage: "starting_now",
                    title: format!("Meeting starting now: {}", event.title),
                    body: "This meeting should be starting now.".to_string(),
                    proactive_message: format!("Your meeting is starting now: {}.", event.title),
                    allow_external: true,
                });
            }
            None
        }
        HeartbeatCategory::Reminders => {
            let lookahead = i64::from(config.heartbeat.reminder_lookahead_minutes.max(1));
            if until_minutes > 0 && until_minutes <= lookahead {
                let mins = until_minutes.max(1);
                return Some(PlannedDelivery {
                    stage: "soon",
                    title: format!("Reminder soon: {}", event.title),
                    body: format!("Scheduled in about {mins} minutes."),
                    proactive_message: format!(
                        "Reminder coming up in about {mins} minutes: {}.",
                        event.title
                    ),
                    allow_external: false,
                });
            }
            // Wider grace window for reminder due state to prevent misses
            // from tick alignment.
            if until_minutes <= 0 && until_minutes >= -10 {
                return Some(PlannedDelivery {
                    stage: "due",
                    title: format!("Reminder due: {}", event.title),
                    body: "A scheduled reminder is due now.".to_string(),
                    proactive_message: format!("Reminder due now: {}.", event.title),
                    allow_external: true,
                });
            }
            None
        }
        HeartbeatCategory::Important => {
            if now.signed_duration_since(event.anchor_at) <= Duration::minutes(10) {
                return Some(PlannedDelivery {
                    stage: "important_now",
                    title: event.title.clone(),
                    body: if event.body.is_empty() {
                        "A time-sensitive event needs your attention.".to_string()
                    } else {
                        event.body.clone()
                    },
                    proactive_message: if event.body.is_empty() {
                        "A time-sensitive event needs your attention.".to_string()
                    } else {
                        event.body.clone()
                    },
                    allow_external: true,
                });
            }
            None
        }
    }
}

fn sanitize_preview(raw: &str, max_chars: usize) -> String {
    let clean = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= max_chars {
        return clean;
    }
    let mut trimmed: String = clean.chars().take(max_chars.saturating_sub(1)).collect();
    trimmed.push('…');
    trimmed
}

fn stable_key(seed: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    hex::encode(hasher.finalize())
}

fn persist_heartbeat_alert(
    config: &Config,
    event: &PendingEvent,
    plan: &PlannedDelivery,
    now: DateTime<Utc>,
) {
    let notification = IntegrationNotification {
        id: format!(
            "heartbeat:{}:{}:{}",
            event.category.as_str(),
            plan.stage,
            &event.fingerprint[..12]
        ),
        provider: "heartbeat".to_string(),
        account_id: Some(event.source_event_id.clone()),
        title: sanitize_preview(&plan.title, 100),
        body: sanitize_preview(&plan.body, 180),
        raw_payload: serde_json::json!({
            "source": event.source,
            "category": event.category.as_str(),
            "stage": plan.stage,
            "anchor_at": event.anchor_at.to_rfc3339(),
            "deep_link": event.deep_link.clone(),
        }),
        importance_score: Some(match event.category {
            HeartbeatCategory::Meetings => 0.8,
            HeartbeatCategory::Reminders => 0.7,
            HeartbeatCategory::Important => 0.9,
        }),
        triage_action: Some("react".to_string()),
        triage_reason: Some("heartbeat proactive event".to_string()),
        status: NotificationStatus::Unread,
        received_at: now,
        scored_at: Some(now),
    };

    if let Err(error) = notifications_store::insert_if_not_recent(config, &notification) {
        tracing::warn!(
            source = %event.source,
            source_event_id = %event.source_event_id,
            category = event.category.as_str(),
            stage = plan.stage,
            error = %error,
            "[heartbeat:planner] failed to persist heartbeat alert"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openhuman::config::Config;
    use crate::openhuman::cron::{self, Schedule};
    use crate::openhuman::notifications::subscribe_core_notifications;
    use chrono::TimeZone;
    use tempfile::TempDir;

    #[test]
    fn extract_calendar_events_reads_nested_payload() {
        let now = Utc.with_ymd_and_hms(2026, 5, 8, 10, 0, 0).unwrap();
        let payload = json!({
            "items": [
                {
                    "id": "evt-1",
                    "summary": "Team sync",
                    "start": { "dateTime": "2026-05-08T10:20:00Z" },
                    "htmlLink": "https://calendar.google.com/event?evt=1"
                }
            ]
        });

        let events = extract_calendar_events(
            &payload,
            "googlecalendar",
            "conn-1",
            now,
            now + Duration::minutes(60),
        );

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].category, HeartbeatCategory::Meetings);
        assert_eq!(events[0].source_event_id, "evt-1");
        assert_eq!(events[0].title, "Team sync");
        assert_eq!(
            events[0].deep_link.as_deref(),
            Some("https://calendar.google.com/event?evt=1")
        );
    }

    #[test]
    fn reminder_stage_prioritizes_due_window() {
        let mut config = Config::default();
        config.heartbeat.reminder_lookahead_minutes = 15;
        let now = Utc.with_ymd_and_hms(2026, 5, 8, 10, 0, 0).unwrap();
        let event = PendingEvent {
            category: HeartbeatCategory::Reminders,
            source: "cron".to_string(),
            source_event_id: "job-1".to_string(),
            fingerprint: "fp-1".to_string(),
            title: "Pay rent".to_string(),
            body: String::new(),
            deep_link: None,
            anchor_at: now,
        };

        let plan = plan_delivery_for_event(&event, &config, now).expect("plan");
        assert_eq!(plan.stage, "due");
        assert!(plan.allow_external);
    }

    #[test]
    fn meeting_stage_uses_heads_up_for_longer_lead() {
        let mut config = Config::default();
        config.heartbeat.meeting_lookahead_minutes = 120;
        let now = Utc.with_ymd_and_hms(2026, 5, 8, 10, 0, 0).unwrap();
        let event = PendingEvent {
            category: HeartbeatCategory::Meetings,
            source: "calendar:googlecalendar".to_string(),
            source_event_id: "evt-1".to_string(),
            fingerprint: "fp-1".to_string(),
            title: "Planning".to_string(),
            body: String::new(),
            deep_link: None,
            anchor_at: now + Duration::minutes(45),
        };

        let plan = plan_delivery_for_event(&event, &config, now).expect("plan");
        assert_eq!(plan.stage, "heads_up");
        assert!(!plan.allow_external);
    }

    #[test]
    fn sanitize_preview_trims_and_normalizes_whitespace() {
        let out = sanitize_preview("  hello   world  ", 30);
        assert_eq!(out, "hello world");

        let out = sanitize_preview("a very long sentence with many words", 10);
        assert!(out.ends_with('…'));
        assert!(out.chars().count() <= 10);
    }

    fn test_config(tmp: &TempDir) -> Config {
        Config {
            workspace_dir: tmp.path().to_path_buf(),
            config_path: tmp.path().join("config.toml"),
            ..Config::default()
        }
    }

    #[tokio::test]
    async fn evaluate_and_dispatch_dedupes_across_ticks() {
        let tmp = TempDir::new().unwrap();
        let mut config = test_config(&tmp);
        config.heartbeat.notify_meetings = false;
        config.heartbeat.notify_relevant_events = false;
        config.heartbeat.notify_reminders = true;
        config.heartbeat.reminder_lookahead_minutes = 30;

        let now = Utc::now();
        let run_at = now + Duration::minutes(5);
        let schedule = Schedule::At { at: run_at };
        let _job = cron::add_shell_job(&config, Some("remind_me".to_string()), schedule, "echo hi")
            .expect("create cron reminder");

        let mut rx = subscribe_core_notifications();
        while rx.try_recv().is_ok() {}

        let first = evaluate_and_dispatch(&config, now).await;
        assert_eq!(first.deliveries_sent, 1);

        let second = evaluate_and_dispatch(&config, now).await;
        assert_eq!(second.deliveries_sent, 0);
        assert!(second.deliveries_skipped_dedup >= 1);
    }

    #[tokio::test]
    async fn heartbeat_provider_notifications_are_not_re_escalated() {
        use crate::openhuman::notifications::store as notifications_store;
        use crate::openhuman::notifications::types::{IntegrationNotification, NotificationStatus};

        let tmp = TempDir::new().unwrap();
        let mut config = test_config(&tmp);
        config.heartbeat.notify_meetings = false;
        config.heartbeat.notify_reminders = false;
        config.heartbeat.notify_relevant_events = true;

        let now = Utc::now();

        // Simulate a previously-persisted heartbeat notification (triage_action="react",
        // status=Unread, importance_score=0.9) — exactly what persist_heartbeat_alert writes.
        let hb_notification = IntegrationNotification {
            id: "heartbeat:meetings:final_call:abc123def456".to_string(),
            provider: "heartbeat".to_string(),
            account_id: None,
            title: "Upcoming meeting: Team sync".to_string(),
            body: "Starts in about 5 minutes.".to_string(),
            raw_payload: serde_json::json!({"category": "meetings", "stage": "final_call"}),
            importance_score: Some(0.9),
            triage_action: Some("react".to_string()),
            triage_reason: Some("heartbeat proactive event".to_string()),
            status: NotificationStatus::Unread,
            received_at: now,
            scored_at: Some(now),
        };
        notifications_store::insert_if_not_recent(&config, &hb_notification).unwrap();

        // Planner must NOT re-escalate notifications it generated itself.
        let summary = evaluate_and_dispatch(&config, now).await;
        assert_eq!(
            summary.deliveries_sent, 0,
            "heartbeat provider notifications must not be re-escalated as Important events"
        );
    }
}
