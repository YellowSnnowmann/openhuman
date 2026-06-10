//! Auto-fallback from the managed cloud embedder to a local embedder when the
//! backend session expires mid-run (#3312).
//!
//! Background: a long-running headless deployment (e.g. Docker) authenticates
//! to the OpenHuman backend with a session JWT that expires after a few hours.
//! Once it expires every cloud embedding call returns `401 Invalid token`, and
//! indexing fails hard with no recovery until a manual provider switch. This
//! module watches for *confirmed* embedding auth failures (HTTP 401/403) and,
//! when the active provider is the managed cloud embedder **and** a local
//! embedder is actually preloaded and reachable at the **same dimensionality**
//! (so no destructive memory wipe is required), persists a switch to the local
//! provider.
//!
//! Persisting the switch via [`crate::openhuman::embeddings::rpc::update_settings`]
//! moves the **active embedding signature** atomically with the provider, so
//! new vectors are correctly labelled and the existing re-embed machinery
//! back-fills the corpus under the local signature. This is the only safe way
//! to fall back: returning local vectors under the cloud signature would
//! silently mix two incomparable embedding spaces (#1574).
//!
//! Safety guards (all must hold before switching):
//! - a confirmed auth failure is latched ([`embedding_auth_failed`]);
//! - the *current* provider is the managed cloud embedder (`cloud`/`managed`) —
//!   a 401 from a user's own OpenAI/custom key must never flip their provider;
//! - a local embedder is reachable;
//! - the local embedder's dimensionality equals the current one, so the switch
//!   needs **no** destructive memory wipe.
//!
//! If any guard fails the gate is a no-op: the cloud failure stays surfaced
//! (graceful skip) rather than switching into a dead provider or wiping memory.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use super::ollama::{DEFAULT_OLLAMA_DIMENSIONS, DEFAULT_OLLAMA_MODEL};
use crate::openhuman::config::Config;

/// Process-global latch: set when an embedding call is rejected with a
/// confirmed auth error (HTTP 401/403). Set from the shared
/// [`super::openai::OpenAiEmbedding::embed`] non-2xx path (which every cloud and
/// BYO embed bottoms out in) and consumed by the memory-queue worker each tick.
///
/// The latch is intentionally generic ("an embedding auth call failed"); the
/// cloud-specific interpretation lives entirely in [`maybe_switch_cloud_to_local`],
/// which only acts when the *configured* provider is the managed cloud one. So
/// a 401 from a user's own key may set the latch but can never switch their
/// provider — it is simply cleared by the next successful embed.
static EMBEDDING_AUTH_FAILED: AtomicBool = AtomicBool::new(false);

/// Record a confirmed embedding auth failure (HTTP 401/403). Cheap and
/// idempotent — logs once per transition into the failed state.
pub fn note_embedding_auth_failure() {
    if !EMBEDDING_AUTH_FAILED.swap(true, Ordering::SeqCst) {
        log::warn!(
            "[embeddings::cloud_fallback] embedding call rejected with auth error (401/403); \
             will switch managed cloud → local if a local embedder is preloaded at matching dims (#3312)"
        );
    }
}

/// Whether a confirmed embedding auth failure is currently latched.
pub fn embedding_auth_failed() -> bool {
    EMBEDDING_AUTH_FAILED.load(Ordering::SeqCst)
}

/// Clear the latch — called after a successful switch, or after any successful
/// embed (a success means the session is valid again, so we must not switch on
/// a stale blip).
pub fn clear_embedding_auth_gate() {
    EMBEDDING_AUTH_FAILED.store(false, Ordering::SeqCst);
}

/// Process-global monotonic counter bumped whenever the embedding provider is
/// switched and persisted by [`maybe_switch_cloud_to_local`]. Every memory-queue
/// worker tracks the last generation it has reloaded; when this differs it
/// reloads its `Config` from disk. This is what makes a persisted switch reach
/// *all* workers (each owns its own `Config` clone), not just the one task that
/// happened to perform the switch.
static CONFIG_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Current config generation. Workers compare this against the generation they
/// last reloaded at to decide whether to re-read `Config` from disk.
pub fn config_generation() -> u64 {
    CONFIG_GENERATION.load(Ordering::SeqCst)
}

/// Bump the config generation, signalling all workers to reload from disk.
fn bump_config_generation() {
    CONFIG_GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// Pure decision core: should the active embedder be switched from managed
/// cloud to local? Split out so the truth table is unit-testable without a
/// live config, credential store, or Ollama daemon.
///
/// `local_available` must mean the target model is actually *usable* (daemon up
/// **and** the model pulled), not merely that the daemon answered — switching
/// onto a reachable daemon that lacks the model would just move indexing onto a
/// provider that immediately fails with "model not found".
fn should_switch(
    auth_failed: bool,
    current_provider: &str,
    current_dims: usize,
    local_available: bool,
    local_dims: usize,
) -> bool {
    auth_failed
        && matches!(current_provider, "cloud" | "managed")
        && local_available
        && local_dims == current_dims
}

/// If a cloud embedding auth failure is latched and a local embedder is
/// available at matching dimensionality, persist a switch to the local
/// provider and return the reloaded [`Config`] so the caller can adopt it
/// immediately (no process restart). Returns `None` when no switch happened.
///
/// Idempotent and safe to call every worker tick: it returns immediately when
/// the latch is clear, and clears the latch once a switch is applied so
/// concurrent workers don't switch twice.
pub async fn maybe_switch_cloud_to_local(config: &Config) -> bool {
    if !embedding_auth_failed() {
        return false;
    }

    let provider = config.memory.embedding_provider.as_str();
    if !matches!(provider, "cloud" | "managed") {
        // The active provider isn't the managed cloud one — the latch came
        // from a BYO 401 (or a switch already happened). Clear it; nothing to
        // do here.
        clear_embedding_auth_gate();
        return false;
    }

    let current_dims = config.memory.embedding_dimensions;
    let base_url = crate::openhuman::inference::local::ollama_base_url();
    // Availability means the daemon is up AND the target model is pulled — a
    // reachable daemon missing the model would just move indexing onto a
    // provider that immediately fails with "model not found".
    let local_available = crate::openhuman::memory_store::factories::probe_ollama_model_available(
        &base_url,
        DEFAULT_OLLAMA_MODEL,
    )
    .await;

    if !should_switch(
        true,
        provider,
        current_dims,
        local_available,
        DEFAULT_OLLAMA_DIMENSIONS,
    ) {
        log::debug!(
            "[embeddings::cloud_fallback] cloud embedding auth failing but local fallback \
             unavailable (model '{DEFAULT_OLLAMA_MODEL}' available={local_available}, \
             local_dims={}, current_dims={current_dims}); leaving cloud provider in place — \
             indexing degrades gracefully until re-auth (#3312)",
            DEFAULT_OLLAMA_DIMENSIONS
        );
        return false;
    }

    log::warn!(
        "[embeddings::cloud_fallback] managed cloud session auth persistently failing and local \
         model '{DEFAULT_OLLAMA_MODEL}' available at matching dims ({current_dims}); switching \
         memory embeddings to local to keep indexing alive (#3312)"
    );

    match crate::openhuman::embeddings::rpc::update_settings(
        Some("ollama".to_string()),
        Some(DEFAULT_OLLAMA_MODEL.to_string()),
        Some(DEFAULT_OLLAMA_DIMENSIONS),
        None,
        None,
        false,
    )
    .await
    {
        Ok(_) => {
            // The switch is now durably persisted to disk. Bump the generation
            // so *every* worker reloads its `Config` from disk (each owns its
            // own clone), then clear the latch. Clearing only after a successful
            // persist means a failed persist (below) leaves the latch set for a
            // retry on the next tick.
            bump_config_generation();
            clear_embedding_auth_gate();
            log::info!(
                "[embeddings::cloud_fallback] switched memory embeddings to local \
                 '{DEFAULT_OLLAMA_MODEL}'; re-embed backfill scheduled under new signature; \
                 workers will reload config (generation={})",
                config_generation()
            );
            true
        }
        Err(e) => {
            // Persisting the switch is an unexpected system failure (config
            // save / RPC error) — report it and leave the latch set so a later
            // tick can retry rather than swallowing the failure.
            crate::core::observability::report_error(
                &format!("cloud_fallback: failed to persist embedding provider switch: {e}"),
                "embeddings",
                "cloud_fallback_switch",
                &[],
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::openhuman::config::Config;

    // The latch is process-global, so every test that touches it must serialize
    // through this lock to stay race-free under cargo's parallel runner (the
    // "no flakes" rule). The pure `should_switch` truth-table tests don't touch
    // the global and so don't take the lock.
    static GATE_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn gate_set_clear_and_idempotency() {
        let _guard = GATE_TEST_LOCK.lock().unwrap();
        clear_embedding_auth_gate();
        assert!(!embedding_auth_failed());

        note_embedding_auth_failure();
        assert!(embedding_auth_failed());

        // Idempotent: a second note keeps it set, no panic.
        note_embedding_auth_failure();
        assert!(embedding_auth_failed());

        clear_embedding_auth_gate();
        assert!(!embedding_auth_failed());
    }

    #[tokio::test]
    async fn maybe_switch_is_noop_when_gate_clear() {
        let _guard = GATE_TEST_LOCK.lock().unwrap();
        clear_embedding_auth_gate();
        // Gate clear → returns immediately, no I/O, regardless of provider.
        let cfg = Config::default();
        assert!(!maybe_switch_cloud_to_local(&cfg).await);
    }

    #[tokio::test]
    async fn maybe_switch_clears_gate_for_non_cloud_provider_without_switching() {
        let _guard = GATE_TEST_LOCK.lock().unwrap();
        // A 401 from a user's own key latches the gate, but the active provider
        // is not the managed cloud one — must clear the latch and never switch
        // (no network probe, no settings write).
        note_embedding_auth_failure();
        let mut cfg = Config::default();
        cfg.memory.embedding_provider = "openai".to_string();
        assert!(!maybe_switch_cloud_to_local(&cfg).await);
        assert!(
            !embedding_auth_failed(),
            "non-cloud provider path must clear the stale latch"
        );
    }

    #[test]
    fn switches_only_when_all_guards_hold() {
        // Happy path: cloud provider, auth failed, local reachable, dims match.
        assert!(should_switch(true, "cloud", 1024, true, 1024));
        assert!(should_switch(true, "managed", 1024, true, 1024));
    }

    #[test]
    fn no_switch_without_auth_failure() {
        assert!(!should_switch(false, "cloud", 1024, true, 1024));
    }

    #[test]
    fn no_switch_for_non_cloud_provider() {
        // A 401 from a user's own OpenAI/custom/voyage key must never flip them.
        assert!(!should_switch(true, "openai", 1024, true, 1024));
        assert!(!should_switch(true, "voyage", 1024, true, 1024));
        assert!(!should_switch(true, "custom:http://x", 1024, true, 1024));
        assert!(!should_switch(true, "ollama", 1024, true, 1024));
    }

    #[test]
    fn no_switch_when_local_unreachable() {
        assert!(!should_switch(true, "cloud", 1024, false, 1024));
    }

    #[test]
    fn no_switch_on_dimension_mismatch_never_auto_wipes() {
        // Different dims would force a destructive memory wipe — never do that
        // automatically on a transient auth failure.
        assert!(!should_switch(true, "cloud", 1024, true, 768));
        assert!(!should_switch(true, "cloud", 1536, true, 1024));
    }
}
