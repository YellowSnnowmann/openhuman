//! Process-lifetime latch recording whether the config loader recovered a
//! corrupted `config.toml` during this session (#5167).
//!
//! The loader (`config::schema::load`) heals a corrupt config on the *first*
//! read of the process by renaming it to `.corrupted.<ts>` and resetting to
//! defaults, so the per-load [`Config::recovered_from_corruption`] flag is only
//! `true` on that first load and `false` on every subsequent read of the
//! now-healed file. The frontend, however, polls `app_state_snapshot` and may
//! not do so until after the heal — by which point the flag would already read
//! `false`. This latch bridges that gap: `bootstrap_core_runtime` sets it once
//! from the boot config, and every later snapshot reports it, so the notice
//! surfaces even though the underlying config is already healthy.
//!
//! [`Config::recovered_from_corruption`]:
//! crate::openhuman::config::Config::recovered_from_corruption

use std::sync::atomic::{AtomicBool, Ordering};

use crate::openhuman::config::Config;

/// `true` once the config loader recovered a corrupted `config.toml` this
/// process lifetime. Never reset in production (a recovery is a one-time,
/// session-scoped fact); tests clear it via [`reset_for_tests`].
static CONFIG_RECOVERED: AtomicBool = AtomicBool::new(false);

/// Record that config-corruption recovery happened this session.
///
/// Idempotent and safe to call repeatedly.
fn mark_config_recovered() {
    CONFIG_RECOVERED.store(true, Ordering::Relaxed);
}

/// Latch the session recovery signal from a freshly-loaded boot config.
///
/// Called once from `bootstrap_core_runtime` with the config returned by
/// `Config::load_or_init`, whose `recovered_from_corruption` is authoritative
/// for this boot. No-op when the config loaded cleanly. Logs at warn so the
/// reset is visible in local logs (it is a Sentry breadcrumb, not an event —
/// the read failure it stems from is expected user-environment state, #5167).
pub fn latch_from_config(config: &Config) {
    if !config.recovered_from_corruption {
        return;
    }
    log::warn!(
        "[app_state] config.toml was unreadable/corrupt on boot and was reset to \
         defaults (previous file kept as .corrupted.<ts>); surfacing a user notice (#5167)"
    );
    mark_config_recovered();
}

/// Whether config-corruption recovery happened this session. Read by
/// `app_state_snapshot` so the frontend can raise a one-shot user notice.
pub fn config_recovered_this_session() -> bool {
    CONFIG_RECOVERED.load(Ordering::Relaxed)
}

/// Reset the latch. Test-only: the static is process-global, so a test that
/// asserts the un-recovered default must clear state a prior test may have set.
#[cfg(test)]
pub fn reset_for_tests() {
    CONFIG_RECOVERED.store(false, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latch_defaults_false_and_marks_true() {
        reset_for_tests();
        assert!(
            !config_recovered_this_session(),
            "latch must default to false"
        );
        mark_config_recovered();
        assert!(
            config_recovered_this_session(),
            "latch must report true after mark"
        );
        // Idempotent — a second mark keeps it true.
        mark_config_recovered();
        assert!(config_recovered_this_session());
        reset_for_tests();
    }

    #[test]
    fn latch_from_config_only_marks_when_recovered() {
        reset_for_tests();

        let mut clean = Config::default();
        clean.recovered_from_corruption = false;
        latch_from_config(&clean);
        assert!(
            !config_recovered_this_session(),
            "a clean boot config must not latch the signal"
        );

        let mut recovered = Config::default();
        recovered.recovered_from_corruption = true;
        latch_from_config(&recovered);
        assert!(
            config_recovered_this_session(),
            "a recovered boot config must latch the signal"
        );
        reset_for_tests();
    }
}
