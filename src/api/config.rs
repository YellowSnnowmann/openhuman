//! Base URL and defaults for the TinyHumans / AlphaHuman hosted API.

/// Default API host when `config.api_url` is unset or blank and no env override is set.
pub const DEFAULT_API_BASE_URL: &str = "https://api.tinyhumans.ai";
/// Default staging API host when the app environment is explicitly `staging`.
pub const DEFAULT_STAGING_API_BASE_URL: &str = "https://staging-api.tinyhumans.ai";
/// Primary app-environment selector used by the core and desktop app.
pub const APP_ENV_VAR: &str = "OPENHUMAN_APP_ENV";
/// Vite-exposed app-environment selector used by the frontend bundle.
pub const VITE_APP_ENV_VAR: &str = "VITE_OPENHUMAN_APP_ENV";

/// Resolves the hosted API base URL (no path suffix).
///
/// Order:
/// 1. Non-empty `api_url` from config (user explicitly set it)
/// 2. `BACKEND_URL` / `VITE_BACKEND_URL` runtime env var
/// 3. `BACKEND_URL` / `VITE_BACKEND_URL` baked in at compile time via `option_env!`
/// 4. Environment-aware default: `app_env_from_env()` == `staging` →
///    [`DEFAULT_STAGING_API_BASE_URL`], otherwise [`DEFAULT_API_BASE_URL`]
pub fn effective_api_url(api_url: &Option<String>) -> String {
    if let Some(u) = api_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return normalize_api_base_url(u);
    }
    if let Some(env_url) = api_base_from_env() {
        return env_url;
    }
    default_api_base_url_for_env(app_env_from_env().as_deref()).to_string()
}

/// Trim and strip trailing slashes so paths join consistently.
pub fn normalize_api_base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// Resolve API base URL from the environment.
///
/// Checks runtime env vars first (`BACKEND_URL`, `VITE_BACKEND_URL`), then
/// falls back to values baked in at compile time via `option_env!`. The
/// compile-time fallback is what makes a shipped DMG/installer resolve to the
/// correct environment — at runtime the process has no shell env vars set.
pub fn api_base_from_env() -> Option<String> {
    // 1. Runtime (developer local or CI with explicit env)
    if let Some(url) = std::env::var("BACKEND_URL")
        .or_else(|_| std::env::var("VITE_BACKEND_URL"))
        .ok()
        .map(|s| normalize_api_base_url(&s))
        .filter(|s| !s.is_empty())
    {
        return Some(url);
    }
    // 2. Compile-time fallback — baked in by build-desktop.yml when
    //    `BACKEND_URL` / `VITE_BACKEND_URL` are set as build env vars.
    //    This is what ensures a staging DMG always hits staging-api and a
    //    prod DMG always hits api.tinyhumans.ai without needing a live env.
    if let Some(v) = option_env!("BACKEND_URL").or(option_env!("VITE_BACKEND_URL")) {
        let url = normalize_api_base_url(v);
        if !url.is_empty() {
            return Some(url);
        }
    }
    None
}

/// Resolve the app environment, checking runtime env first then compile-time.
///
/// The compile-time fallback (`option_env!`) mirrors what the Tauri shell
/// already does for its Sentry environment tag — it ensures `OPENHUMAN_APP_ENV`
/// and `VITE_OPENHUMAN_APP_ENV` set during `cargo build` in CI are baked into
/// the binary and available when the installed app runs with no shell env.
pub fn app_env_from_env() -> Option<String> {
    // 1. Runtime
    if let Ok(v) = std::env::var(APP_ENV_VAR).or_else(|_| std::env::var(VITE_APP_ENV_VAR)) {
        let s = v.trim().to_ascii_lowercase();
        if !s.is_empty() {
            return Some(s);
        }
    }
    // 2. Compile-time fallback
    if let Some(v) =
        option_env!("OPENHUMAN_APP_ENV").or(option_env!("VITE_OPENHUMAN_APP_ENV"))
    {
        let s = v.trim().to_ascii_lowercase();
        if !s.is_empty() {
            return Some(s);
        }
    }
    None
}

pub fn is_staging_app_env(app_env: Option<&str>) -> bool {
    matches!(app_env.map(str::trim), Some(env) if env.eq_ignore_ascii_case("staging"))
}

pub fn default_api_base_url_for_env(app_env: Option<&str>) -> &'static str {
    if is_staging_app_env(app_env) {
        DEFAULT_STAGING_API_BASE_URL
    } else {
        DEFAULT_API_BASE_URL
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staging_app_env_uses_staging_default_api() {
        assert_eq!(
            default_api_base_url_for_env(Some("staging")),
            DEFAULT_STAGING_API_BASE_URL
        );
        assert!(is_staging_app_env(Some("STAGING")));
    }

    #[test]
    fn non_staging_app_env_uses_production_default_api() {
        assert_eq!(
            default_api_base_url_for_env(Some("production")),
            DEFAULT_API_BASE_URL
        );
        assert_eq!(default_api_base_url_for_env(None), DEFAULT_API_BASE_URL);
        assert!(!is_staging_app_env(Some("development")));
    }

    #[test]
    fn app_env_from_env_reads_runtime_var() {
        let key = "OPENHUMAN_APP_ENV";
        // Guard: stash and restore so parallel tests are not affected.
        let prev = std::env::var(key).ok();
        std::env::set_var(key, "staging");
        let result = app_env_from_env();
        match prev {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        assert_eq!(result.as_deref(), Some("staging"));
    }

    #[test]
    fn api_base_from_env_reads_runtime_var() {
        let key = "BACKEND_URL";
        let prev = std::env::var(key).ok();
        std::env::set_var(key, "https://staging-api.tinyhumans.ai/");
        let result = api_base_from_env();
        match prev {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        assert_eq!(
            result.as_deref(),
            Some("https://staging-api.tinyhumans.ai")
        );
    }
}
