//! A single pooled worker: one long-lived interpreter child speaking the
//! newline-delimited JSON [`protocol`](super::protocol) over stdio.
//!
//! One worker runs **one job at a time**; concurrency comes from the
//! [`LangPool`](super::pool::LangPool) holding several workers. A worker stays
//! warm between jobs (the whole point — no per-run interpreter spawn) until it
//! is idle-reaped or recycled after N jobs.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

use super::protocol::{PoolJobRequest, PoolJobResponse, PoolReadyLine, PROTOCOL_VERSION};
use super::types::PoolLang;

/// How long to wait for a freshly-spawned worker to print its ready line.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// Everything needed to (re)spawn a worker for one language. Cheap to clone so
/// the pool can respawn on demand.
#[derive(Debug, Clone)]
pub struct WorkerLaunch {
    pub lang: PoolLang,
    /// Interpreter binary (`node` / `python`).
    pub bin: PathBuf,
    /// Args after the binary — typically `[harness_script_path]`.
    pub args: Vec<String>,
    /// Full environment for the child (already allow-listed by the backend).
    /// The child's env is cleared first, so this is the complete set.
    pub env: Vec<(String, String)>,
}

/// A warm interpreter child plus its bookkeeping.
pub struct PoolWorker {
    launch: WorkerLaunch,
    _child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    jobs_done: u64,
    last_used: Instant,
}

impl PoolWorker {
    pub fn jobs_done(&self) -> u64 {
        self.jobs_done
    }

    pub fn last_used(&self) -> Instant {
        self.last_used
    }

    /// Spawn a new worker and complete the readiness handshake.
    pub async fn spawn(launch: &WorkerLaunch) -> Result<Self> {
        tracing::info!(
            lang = launch.lang.id(),
            bin = %launch.bin.display(),
            "[runtime_pool] spawning worker"
        );
        let mut cmd = Command::new(&launch.bin);
        cmd.args(&launch.args);
        cmd.env_clear();
        for (key, value) in &launch.env {
            cmd.env(key, value);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Suppress the Windows console flash for each spawned worker.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .with_context(|| format!("spawning {} worker", launch.lang.id()))?;
        let stdin = child.stdin.take().context("worker stdin missing")?;
        let stdout = child.stdout.take().context("worker stdout missing")?;
        if let Some(stderr) = child.stderr.take() {
            drain_stderr(launch.lang, stderr);
        }
        let mut lines = BufReader::new(stdout).lines();

        let ready_line = match tokio::time::timeout(HANDSHAKE_TIMEOUT, lines.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => bail!(
                "{} worker exited before readiness handshake",
                launch.lang.id()
            ),
            Ok(Err(error)) => {
                return Err(error).context("reading worker handshake");
            }
            Err(_) => bail!("{} worker readiness handshake timed out", launch.lang.id()),
        };
        let ready: PoolReadyLine = serde_json::from_str(&ready_line)
            .with_context(|| format!("parsing worker ready line: {ready_line}"))?;
        if !ready.ready {
            bail!(
                "{} worker failed to start: {}",
                launch.lang.id(),
                ready.error.unwrap_or_else(|| "unknown".to_string())
            );
        }
        if ready.protocol != Some(PROTOCOL_VERSION) {
            bail!(
                "{} worker protocol mismatch: expected {}, got {:?}",
                launch.lang.id(),
                PROTOCOL_VERSION,
                ready.protocol
            );
        }
        tracing::info!(lang = launch.lang.id(), "[runtime_pool] worker ready");

        Ok(Self {
            launch: launch.clone(),
            _child: child,
            stdin,
            stdout: lines,
            jobs_done: 0,
            last_used: Instant::now(),
        })
    }

    /// Submit one job and await its response.
    ///
    /// `hard_timeout` is a **safety net** above the worker's own soft deadline:
    /// the worker aborts a job at `req.timeout_ms` and still replies, so this
    /// only fires if the worker itself has wedged. On `Err` the caller must
    /// discard this worker — its stdio framing can no longer be trusted.
    pub async fn submit(
        &mut self,
        req: &PoolJobRequest,
        hard_timeout: Option<Duration>,
    ) -> Result<PoolJobResponse> {
        let mut line = serde_json::to_string(req).context("serialising pool job")?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .context("writing pool job request")?;
        self.stdin
            .flush()
            .await
            .context("flushing pool job request")?;

        loop {
            let next = match hard_timeout {
                Some(timeout) => match tokio::time::timeout(timeout, self.stdout.next_line()).await
                {
                    Ok(inner) => inner,
                    Err(_) => bail!("pool worker job timed out (hard deadline; worker wedged)"),
                },
                None => self.stdout.next_line().await,
            };
            let line = match next {
                Ok(Some(line)) => line,
                Ok(None) => bail!("pool worker closed stdout"),
                Err(error) => return Err(error).context("reading pool job response"),
            };
            let response: PoolJobResponse = match serde_json::from_str(&line) {
                Ok(response) => response,
                Err(error) => {
                    tracing::warn!(
                        lang = self.launch.lang.id(),
                        "[runtime_pool] unparseable worker line skipped: {error}"
                    );
                    continue;
                }
            };
            if response.id.as_deref() != Some(req.id.as_str()) {
                tracing::debug!(
                    lang = self.launch.lang.id(),
                    "[runtime_pool] skipped response for different id={:?}",
                    response.id
                );
                continue;
            }
            self.jobs_done += 1;
            self.last_used = Instant::now();
            return Ok(response);
        }
    }

    /// Whether this worker has served enough jobs to be recycled. `0` disables.
    pub fn should_recycle(&self, recycle_after: u64) -> bool {
        recycle_after > 0 && self.jobs_done >= recycle_after
    }

    /// Whether this worker has been idle at least `ttl`.
    pub fn idle_expired(&self, ttl: Duration) -> bool {
        self.last_used.elapsed() >= ttl
    }

    /// Signal the child to exit. Best-effort; `kill_on_drop` is the backstop.
    pub fn shutdown(mut self) {
        if let Err(error) = self._child.start_kill() {
            tracing::debug!(
                lang = self.launch.lang.id(),
                "[runtime_pool] failed to signal worker shutdown: {error}"
            );
        }
    }
}

/// Continuously drain a worker's stderr so a chatty child never blocks on a
/// full pipe. Lines are logged at trace; never parsed as protocol.
fn drain_stderr(lang: PoolLang, stderr: ChildStderr) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            tracing::trace!(lang = lang.id(), "[runtime_pool] worker stderr: {line}");
        }
    });
}
