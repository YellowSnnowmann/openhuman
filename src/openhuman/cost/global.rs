//! Process-global `CostTracker` singleton.
//!
//! The dashboard RPC handlers and agent-turn telemetry hook share a single
//! tracker instance so cost records are persisted exactly once per provider
//! call and the in-memory daily/monthly aggregates stay coherent.
//!
//! Initialisation is intentionally lazy from the caller's perspective: the
//! `bootstrap_core_runtime` path calls [`init_global`] at startup, and any
//! later call is a no-op. Callers that run before bootstrap (e.g. unit
//! tests) see `None` from [`try_global`] and skip recording — never a panic.

use std::path::Path;
use std::sync::Arc;

use once_cell::sync::OnceCell;

use crate::openhuman::config::CostConfig;
use crate::openhuman::inference::provider::traits::UsageInfo;

use super::tracker::CostTracker;
use super::types::TokenUsage;

static GLOBAL_TRACKER: OnceCell<Arc<CostTracker>> = OnceCell::new();

/// Initialise the global cost tracker. Idempotent — subsequent calls are
/// no-ops and the original tracker is preserved. Logs (but does not panic)
/// when construction fails so a bad workspace path never blocks core boot.
pub fn init_global(config: CostConfig, workspace_dir: &Path) {
    if GLOBAL_TRACKER.get().is_some() {
        return;
    }
    match CostTracker::new(config, workspace_dir) {
        Ok(tracker) => {
            let _ = GLOBAL_TRACKER.set(Arc::new(tracker));
            log::info!(
                "[cost] global CostTracker initialised at workspace {}",
                workspace_dir.display()
            );
        }
        Err(err) => {
            log::warn!(
                "[cost] failed to initialise global CostTracker at {}: {err} \
                 — cost dashboard will report empty data until next core start",
                workspace_dir.display()
            );
        }
    }
}

/// Fetch the global tracker if it has been initialised. Returns `None`
/// before bootstrap or after an init failure — callers must treat the
/// absence as a soft no-op.
pub fn try_global() -> Option<Arc<CostTracker>> {
    GLOBAL_TRACKER.get().cloned()
}

/// Convenience hook used by the agent turn loop: translates a provider
/// [`UsageInfo`] into a [`TokenUsage`] record and persists it via the
/// global tracker. Silently skipped when the tracker is uninitialised.
/// Errors are logged but never propagated — cost tracking must never
/// break a turn.
///
/// Note: this path uses
/// [`crate::openhuman::cost::tracker::CostTracker::record_usage_unconditional`],
/// so dashboard telemetry is captured even when `cost.enabled = false` —
/// the `cost.enabled` flag gates budget enforcement (refusing requests),
/// not observability. This lets users see history first and decide
/// whether to switch on enforcement.
///
/// `model` is the model identifier the request was routed to (e.g.
/// `"anthropic/claude-sonnet-4-20250514"`) and is used as the bucket key
/// in per-model aggregates.
pub fn record_provider_usage(model: &str, usage: &UsageInfo) {
    let Some(tracker) = try_global() else {
        return;
    };
    if usage.input_tokens == 0 && usage.output_tokens == 0 && usage.charged_amount_usd == 0.0 {
        return;
    }
    let total_tokens = usage.input_tokens.saturating_add(usage.output_tokens);
    let token_usage = TokenUsage {
        model: model.to_string(),
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens,
        cost_usd: if usage.charged_amount_usd.is_finite() && usage.charged_amount_usd >= 0.0 {
            usage.charged_amount_usd
        } else {
            0.0
        },
        timestamp: chrono::Utc::now(),
    };
    if let Err(err) = tracker.record_usage_unconditional(token_usage) {
        log::debug!("[cost] record_provider_usage failed: {err}");
    }
}
