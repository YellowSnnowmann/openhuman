//! Listen path v2: drains Meet's built-in captions region via the
//! `captions_bridge.js` we install at session start, and forwards each
//! new line to core's `meet_agent_push_caption` RPC.
//!
//! Replaces the old [`super::listen_capture`] (CEF audio handler →
//! Whisper STT) which proved unreliable: CEF's `cef_audio_handler_t`
//! is queried lazily on first audio output, so a solo agent in a
//! lobby never engaged the pipeline. Captions handle that case for
//! free — Meet's STT is already running, speaker-attributed, and
//! pre-segmented.
//!
//! Lifecycle is owned by [`super::SpeakPump`]'s sibling: dropping the
//! returned [`CaptionListener`] shuts the polling task down.

use std::time::Duration;

use tokio::sync::oneshot;
use tokio::time::interval;

use crate::cdp::CdpConn;

use super::inject;

/// Polling cadence for `__openhumanDrainCaptions`. Captions arrive at
/// roughly word-by-word frequency; 500 ms is the sweet spot between
/// "responsive enough that wake-word detection feels live" and "not
/// hammering the CDP socket".
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Cap on consecutive drain failures before the listener gives up.
/// Same shape as the speak pump — usually means the page navigated
/// away (call ended) or the renderer crashed.
const MAX_CONSECUTIVE_ERRORS: u32 = 30;

/// How often (in ticks) to log a diagnostic heartbeat when drains are
/// empty. 60 ticks × 500 ms = every 30 s.
const DIAG_HEARTBEAT_TICKS: u64 = 60;

/// RAII handle. Drop to stop the listener task.
pub struct CaptionListener {
    pub request_id: String,
    pub(crate) _shutdown_tx: Option<oneshot::Sender<()>>,
}

impl Drop for CaptionListener {
    fn drop(&mut self) {
        let _ = self._shutdown_tx.take();
    }
}

/// Spawn the caption polling loop for a session whose audio bridge
/// has already installed both `audio_bridge.js` and
/// `captions_bridge.js`. Owns its own clone of the CDP connection so
/// drains run concurrently with speak-pump feeds.
pub fn start(request_id: String, cdp: CdpConn, session_id: String) -> CaptionListener {
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let request_id_for_task = request_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = interval(POLL_INTERVAL);
        // Burn the first tick so the very first drain has something
        // to drain (the page-side observer needs ~250 ms to attach).
        tick.tick().await;
        let mut cdp = cdp;
        let mut errors: u32 = 0;
        let mut tick_count: u64 = 0;
        let mut total_captions: u64 = 0;

        log::info!("[meet-audio] caption listener started request_id={request_id_for_task}");

        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    log::info!(
                        "[meet-audio] caption listener shutdown request_id={request_id_for_task}"
                    );
                    break;
                }
                _ = tick.tick() => {
                    tick_count += 1;
                    match drain_and_forward(&request_id_for_task, &mut cdp, &session_id).await {
                        Ok(count) => {
                            errors = 0;
                            total_captions += count;
                        },
                        Err(err) => {
                            errors += 1;
                            log::debug!(
                                "[meet-audio] caption tick err request_id={request_id_for_task} consec_errors={errors} err={err}"
                            );
                            if errors >= MAX_CONSECUTIVE_ERRORS {
                                log::warn!(
                                    "[meet-audio] caption listener giving up after {errors} consecutive errors request_id={request_id_for_task}"
                                );
                                break;
                            }
                        }
                    }

                    // Periodic diagnostic heartbeat so silent caption
                    // listeners are visible in the logs.
                    if tick_count % DIAG_HEARTBEAT_TICKS == 0 {
                        let bridge_info = probe_bridge_info(&mut cdp, &session_id).await;
                        log::info!(
                            "[meet-audio] caption listener heartbeat request_id={request_id_for_task} \
                             ticks={tick_count} total_captions={total_captions} \
                             consec_errors={errors} bridge={bridge_info}"
                        );
                    }
                }
            }
        }
    });

    CaptionListener {
        request_id,
        _shutdown_tx: Some(shutdown_tx),
    }
}

/// Returns the number of captions forwarded to core.
async fn drain_and_forward(
    request_id: &str,
    cdp: &mut CdpConn,
    session_id: &str,
) -> Result<u64, String> {
    let captions = inject::drain_captions(cdp, session_id).await?;
    if captions.is_empty() {
        return Ok(0);
    }
    let count = captions.len() as u64;
    log::info!("[meet-audio] captions drained count={count} request_id={request_id}",);
    for (speaker, text, ts_ms) in captions {
        // Propagate the failure so MAX_CONSECUTIVE_ERRORS can trip if
        // core's session/RPC path is broken — without this the
        // listener would silently drop captions forever while the
        // page kept producing them.
        super::rpc_call(
            "openhuman.meet_agent_push_caption",
            serde_json::json!({
                "request_id": request_id,
                "speaker": speaker,
                "text": text,
                "ts_ms": ts_ms,
            }),
        )
        .await
        .map_err(|err| format!("push_caption (request_id={request_id}): {err}"))?;
    }
    Ok(count)
}

/// Query the page-side captions bridge for diagnostic info. Never
/// fails — returns a human-readable string for the heartbeat log.
async fn probe_bridge_info(cdp: &mut CdpConn, session_id: &str) -> String {
    let res = cdp
        .call(
            "Runtime.evaluate",
            serde_json::json!({
                "expression": "(typeof window.__openhumanCaptionsBridgeInfo === 'function') \
                               ? JSON.stringify(window.__openhumanCaptionsBridgeInfo()) \
                               : '{\"installed\":false}'",
                "returnByValue": true,
            }),
            Some(session_id),
        )
        .await;
    match res {
        Ok(v) => v
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(|v| v.as_str())
            .unwrap_or("{\"error\":\"no value\"}")
            .to_string(),
        Err(err) => format!("{{\"error\":\"{err}\"}}"),
    }
}
