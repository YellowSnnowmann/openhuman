//! Shared, bounded pools of long-lived `node` / `python` worker processes that
//! execute inline code jobs for skill runs and the `node_exec` agent tool —
//! instead of forking one interpreter child per execution (issue #5106).
//!
//! ## Why
//!
//! A single JS skill step spawns a `node` child at ~72–75 MB RSS. At the
//! opencompany target (100–1000 live agents in 2 GB / 2 vCPU) those per-run
//! interpreter children are the biggest budget breaker. Sharing a small bounded
//! pool of warm workers turns *K concurrent skill runs → K interpreters* into
//! *K concurrent skill runs → ~one pooled worker*, trading a little latency
//! (work beyond the pool size queues) for a large, flat memory floor.
//!
//! ## Shape
//!
//! * [`worker`] — one warm interpreter child speaking newline-delimited JSON.
//! * [`pool`] — the bounded [`LangPool`](pool::LangPool): semaphore-gated
//!   concurrency, queue backpressure, idle-TTL reaping, recycle-after-N-jobs,
//!   plus the process-global registry keyed per language.
//! * [`node`] / [`python`] — language backends that resolve the interpreter,
//!   materialise the harness script, and submit inline jobs.
//!
//! The whole subsystem is an **optimisation seam**: `runtime_pool.enabled =
//! false` (or a per-language flag) reverts callers to their legacy per-call
//! spawn with no behavioural change.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tokio::sync::OnceCell;

pub mod node;
pub mod pool;
pub mod protocol;
pub mod python;
pub mod types;
pub mod worker;

pub use pool::{all_stats, LangPool, PoolStats};
pub use types::{PoolExecOutcome, PoolLang, PoolSettings};

/// Env vars forwarded (allow-listed) into pooled workers. Mirrors the
/// `node_exec` / shell hygiene: secrets never leak into a worker's environment;
/// `PATH` is rebuilt separately with the managed interpreter's bin dir first.
const SAFE_ENV_VARS: &[&str] = &[
    "HOME",
    "TERM",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "USER",
    "SHELL",
    "TMPDIR",
    // Windows process creation + child command lookup after env_clear().
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
];

/// Build the allow-listed environment for a worker, with `bin_dir` prepended to
/// `PATH` so the child resolves the managed interpreter (and its tools).
pub(crate) fn base_env(bin_dir: &Path) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::new();

    let host_path = std::env::var("PATH").unwrap_or_default();
    let sep = if cfg!(windows) { ";" } else { ":" };
    let path = if host_path.is_empty() {
        bin_dir.to_string_lossy().into_owned()
    } else {
        format!("{}{}{}", bin_dir.display(), sep, host_path)
    };
    env.push(("PATH".to_string(), path));

    for var in SAFE_ENV_VARS {
        if let Ok(val) = std::env::var(var) {
            env.push(((*var).to_string(), val));
        }
    }
    env
}

/// Materialise a bundled harness script into a stable per-workspace cache path
/// and return it.
async fn write_worker_script(
    workspace_dir: &Path,
    filename: &str,
    contents: &str,
) -> Result<PathBuf> {
    let root = workspace_dir.join("runtime_pool");
    tokio::fs::create_dir_all(&root)
        .await
        .with_context(|| format!("creating runtime_pool cache {}", root.display()))?;
    let path = root.join(filename);
    tokio::fs::write(&path, contents)
        .await
        .with_context(|| format!("writing worker script {}", path.display()))?;
    Ok(path)
}

/// Return the harness script path, writing it **once per process** (a hot-path
/// `node_exec`/`python_exec` must not touch disk on every call — the point of
/// #5106 is to *reduce* per-run cost). The script is written on the first inline
/// exec and cached; a core upgrade is a fresh process, so it re-materialises
/// then, keeping the shipped harness current.
pub(crate) async fn ensure_worker_script(
    cell: &'static OnceCell<PathBuf>,
    workspace_dir: &Path,
    filename: &str,
    contents: &str,
) -> Result<PathBuf> {
    Ok(cell
        .get_or_try_init(|| write_worker_script(workspace_dir, filename, contents))
        .await?
        .clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_env_prepends_bin_dir_to_path() {
        let env = base_env(Path::new("/managed/bin"));
        let path = env
            .iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.clone())
            .expect("PATH present");
        assert!(
            path.starts_with("/managed/bin"),
            "bin dir must be first on PATH; got {path}"
        );
    }

    #[tokio::test]
    async fn write_worker_script_roundtrips() {
        let tmp = std::env::temp_dir().join(format!("rt-pool-test-{}", std::process::id()));
        let path = write_worker_script(&tmp, "probe.js", "console.log('hi')")
            .await
            .expect("script written");
        let read = tokio::fs::read_to_string(&path).await.unwrap();
        assert_eq!(read, "console.log('hi')");
        let _ = tokio::fs::remove_dir_all(&tmp).await;
    }
}
