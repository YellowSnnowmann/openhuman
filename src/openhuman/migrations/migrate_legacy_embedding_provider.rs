//! Migration 6 → 7: retire the removed `"fastembed"` embedding provider.
//!
//! ## The problem
//!
//! Older builds shipped a local `"fastembed"` embedding provider (BGE models,
//! 384 dims). It has since been removed from the binary entirely — it is not a
//! cargo feature, it simply no longer exists in
//! [`crate::openhuman::embeddings::factory::create_embedding_provider`], which
//! hard-errors on any unknown provider string.
//!
//! Users who selected (or defaulted to) `"fastembed"` on an older build keep
//! `embedding_provider = "fastembed"` in their persisted `config.toml`. On
//! upgrade, the channel runtime's memory store build calls the factory with
//! that stale value → `Err("unknown embedding provider: \"fastembed\"")` →
//! `start_channels` aborts → **all messaging channels (Telegram/Discord) go
//! offline** with no surfaced error (issue #3712).
//!
//! ## What this migration does
//!
//! A pure, idempotent mutation of the persisted `Config`: when
//! `memory.embedding_provider` is the removed `"fastembed"` value, rewrite it to
//! the managed cloud backend (the current fresh-install default) and reset the
//! model/dimensions to the cloud defaults, since the legacy BGE model/384-dim
//! values are incompatible with the managed embedder.
//!
//! Stored vectors written at the old signature are left in place: they are
//! ignored by signature-filtered vector search and re-generated lazily by the
//! existing re-embed backfill ([`crate::openhuman::memory_queue::ensure_reembed_backfill`])
//! once memory next syncs. No DB surgery happens here — this mirrors the
//! pure-config-mutation contract of the other migration steps.
//!
//! ## Behaviour
//!
//! - Pure in-memory mutation of `Config`; the caller (`migrations::run_pending`)
//!   persists via `Config::save()` and bumps `schema_version`.
//! - Idempotent: once rewritten the provider is `"managed"`, so a second run is
//!   a no-op.
//! - Never touches keys/secrets or any other config field.

use crate::openhuman::config::Config;
use crate::openhuman::embeddings::{DEFAULT_CLOUD_EMBEDDING_DIMENSIONS, DEFAULT_CLOUD_EMBEDDING_MODEL};

/// The removed provider value that must not reach the embedding factory.
const REMOVED_PROVIDER: &str = "fastembed";

/// Managed cloud backend — the current fresh-install default and the
/// rewrite target. Matches `create_embedding_provider`'s accepted name.
const MANAGED_PROVIDER: &str = "managed";

/// Counters returned by [`run`] for diagnostics. Logged at INFO once per run.
#[derive(Debug, Default, Clone)]
pub struct MigrationStats {
    /// Whether the removed `"fastembed"` provider was rewritten to managed.
    pub provider_migrated: bool,
    /// Embedding dimensionality before the rewrite (for the log line).
    pub old_dimensions: usize,
    /// Embedding dimensionality after the rewrite.
    pub new_dimensions: usize,
}

/// Rewrite a persisted `"fastembed"` embedding provider to the managed cloud
/// backend.
///
/// Synchronous — pure config mutation, no I/O. Caller persists via
/// `Config::save()` once `schema_version` is also bumped.
///
/// Returns `anyhow::Result` for uniformity with the other migration steps in
/// [`super`]; this pass has no fallible operations today and always returns
/// `Ok`.
pub fn run(config: &mut Config) -> anyhow::Result<MigrationStats> {
    let mut stats = MigrationStats {
        old_dimensions: config.memory.embedding_dimensions,
        new_dimensions: config.memory.embedding_dimensions,
        ..Default::default()
    };

    if !config
        .memory
        .embedding_provider
        .trim()
        .eq_ignore_ascii_case(REMOVED_PROVIDER)
    {
        log::debug!(
            "[migrations][legacy-embedding] embedding_provider is not the removed \
             \"{REMOVED_PROVIDER}\" — nothing to do"
        );
        return Ok(stats);
    }

    config.memory.embedding_provider = MANAGED_PROVIDER.to_string();
    config.memory.embedding_model = DEFAULT_CLOUD_EMBEDDING_MODEL.to_string();
    config.memory.embedding_dimensions = DEFAULT_CLOUD_EMBEDDING_DIMENSIONS;

    stats.provider_migrated = true;
    stats.new_dimensions = DEFAULT_CLOUD_EMBEDDING_DIMENSIONS;

    log::info!(
        "[migrations][legacy-embedding] embedding_provider \"{REMOVED_PROVIDER}\" -> \
         \"{MANAGED_PROVIDER}\" (model={DEFAULT_CLOUD_EMBEDDING_MODEL}, dims {} -> {}); \
         stale vectors re-embed lazily via backfill",
        stats.old_dimensions,
        stats.new_dimensions,
    );

    Ok(stats)
}

#[cfg(test)]
#[path = "migrate_legacy_embedding_provider_tests.rs"]
mod tests;
