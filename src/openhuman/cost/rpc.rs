//! RPC handlers for the cost dashboard surface.
//!
//! The handlers prefer the process-global [`CostTracker`] populated at boot
//! by [`crate::openhuman::cost::init_global`]. When the global is missing —
//! e.g. when the dashboard RPC fires before bootstrap completes, or after a
//! tracker-construction failure — the handler constructs a fallback tracker
//! against the config-provided workspace so the UI gets an answer rather
//! than an error. The fallback is read-only by design: it shares the same
//! JSONL file as the real tracker and will see whatever is on disk.

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

use crate::openhuman::config::{Config, CostConfig};
use crate::rpc::RpcOutcome;

use super::global::try_global;
use super::tracker::CostTracker;
use super::types::{BudgetStatus, CostDashboard, CostSummary, DailyCostEntry, ModelStats};

#[derive(Debug, Clone, Serialize)]
pub struct DailyCostEntryDto {
    pub date: String,
    pub cost_usd: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub request_count: usize,
    pub by_model: Vec<ModelStatsDto>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelStatsDto {
    pub model: String,
    pub cost_usd: f64,
    pub total_tokens: u64,
    pub request_count: usize,
    pub provider: Option<String>,
    pub percent_of_total: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CostDashboardDto {
    pub days: Vec<DailyCostEntryDto>,
    pub period_total_usd: f64,
    pub monthly_pace_usd: f64,
    pub budget_limit_monthly_usd: f64,
    pub month_to_date_usd: f64,
    pub budget_utilization: f64,
    pub budget_status: BudgetStatus,
    pub currency: String,
    pub warn_threshold: f64,
    pub alert_threshold: f64,
    pub enabled: bool,
    pub by_model: Vec<ModelStatsDto>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CostSummaryDto {
    pub session_cost_usd: f64,
    pub daily_cost_usd: f64,
    pub monthly_cost_usd: f64,
    pub total_tokens: u64,
    pub request_count: usize,
    pub by_model: Vec<ModelStatsDto>,
}

fn provider_for(model: &str) -> Option<String> {
    model.split_once('/').map(|(prov, _)| prov.to_string())
}

fn model_stats_to_dto(stats: &ModelStats, total_cost: f64) -> ModelStatsDto {
    let percent_of_total = if total_cost > 0.0 {
        (stats.cost_usd / total_cost) * 100.0
    } else {
        0.0
    };
    ModelStatsDto {
        model: stats.model.clone(),
        cost_usd: stats.cost_usd,
        total_tokens: stats.total_tokens,
        request_count: stats.request_count,
        provider: provider_for(&stats.model),
        percent_of_total,
    }
}

fn daily_entry_to_dto(entry: &DailyCostEntry) -> DailyCostEntryDto {
    let mut by_model: Vec<ModelStatsDto> = entry
        .by_model
        .values()
        .map(|m| model_stats_to_dto(m, entry.cost_usd))
        .collect();
    by_model.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    DailyCostEntryDto {
        date: entry.date.format("%Y-%m-%d").to_string(),
        cost_usd: entry.cost_usd,
        input_tokens: entry.input_tokens,
        output_tokens: entry.output_tokens,
        total_tokens: entry.total_tokens,
        request_count: entry.request_count,
        by_model,
    }
}

fn dashboard_to_dto(dash: CostDashboard, cost_cfg: &CostConfig) -> CostDashboardDto {
    let total = dash.period_total_usd;
    let days = dash.days.iter().map(daily_entry_to_dto).collect();
    let by_model = dash
        .by_model
        .iter()
        .map(|m| model_stats_to_dto(m, total))
        .collect();
    CostDashboardDto {
        days,
        period_total_usd: dash.period_total_usd,
        monthly_pace_usd: dash.monthly_pace_usd,
        budget_limit_monthly_usd: dash.budget_limit_monthly_usd,
        month_to_date_usd: dash.month_to_date_usd,
        budget_utilization: dash.budget_utilization,
        budget_status: dash.budget_status,
        currency: dash.currency,
        warn_threshold: cost_cfg.dashboard.warn_threshold,
        alert_threshold: cost_cfg.dashboard.alert_threshold,
        enabled: cost_cfg.dashboard.enabled,
        by_model,
    }
}

fn summary_to_dto(s: &CostSummary) -> CostSummaryDto {
    let total = s.session_cost_usd;
    let mut by_model: Vec<ModelStatsDto> = s
        .by_model
        .values()
        .map(|m| model_stats_to_dto(m, total))
        .collect();
    by_model.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    CostSummaryDto {
        session_cost_usd: s.session_cost_usd,
        daily_cost_usd: s.daily_cost_usd,
        monthly_cost_usd: s.monthly_cost_usd,
        total_tokens: s.total_tokens,
        request_count: s.request_count,
        by_model,
    }
}

fn resolve_tracker(config: &Config) -> Result<Arc<CostTracker>> {
    if let Some(global) = try_global() {
        return Ok(global);
    }
    let tracker = CostTracker::new(config.cost.clone(), &config.workspace_dir)
        .context("Failed to construct fallback CostTracker for dashboard RPC")?;
    Ok(Arc::new(tracker))
}

/// Build the dashboard payload for the current config.
pub fn dashboard(config: &Config) -> Result<RpcOutcome<Value>> {
    let tracker = resolve_tracker(config)?;
    let dash = tracker
        .get_dashboard(
            &config.cost.dashboard.currency,
            config.cost.dashboard.warn_threshold,
            config.cost.dashboard.alert_threshold,
        )
        .context("cost dashboard query failed")?;
    let dto = dashboard_to_dto(dash, &config.cost);
    let value = serde_json::to_value(dto).context("cost dashboard serialize failed")?;
    Ok(RpcOutcome::new(value, Vec::new()))
}

/// Return the per-day cost history for the requested span.
pub fn daily_history(config: &Config, days: u32) -> Result<RpcOutcome<Value>> {
    let tracker = resolve_tracker(config)?;
    let entries = tracker
        .get_daily_history(days)
        .context("cost daily history query failed")?;
    let dto: Vec<DailyCostEntryDto> = entries.iter().map(daily_entry_to_dto).collect();
    let value = serde_json::to_value(dto).context("cost daily history serialize failed")?;
    Ok(RpcOutcome::new(value, Vec::new()))
}

/// Return the live session / daily / monthly summary.
pub fn summary(config: &Config) -> Result<RpcOutcome<Value>> {
    let tracker = resolve_tracker(config)?;
    let s = tracker.get_summary().context("cost summary query failed")?;
    let dto = summary_to_dto(&s);
    let value = serde_json::to_value(dto).context("cost summary serialize failed")?;
    Ok(RpcOutcome::new(value, Vec::new()))
}
