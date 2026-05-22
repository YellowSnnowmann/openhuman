//! CDP-driven Meet join automation.
//!
//! Runs once per call, after `meet_call::meet_call_open_window` has
//! successfully built the dedicated CEF webview. Connects to CEF's
//! browser-level WebSocket, attaches to the new Meet target, and walks
//! through the join page in three phases:
//!
//!  1. Dismiss the device-check ("Continue without microphone and camera").
//!  2. Type the supplied guest display name into the "Your name" input.
//!  3. Click "Ask to join".
//!
//! All steps go through CDP from this scanner side — there is **no**
//! init-script JS injected into the webview. `Runtime.evaluate` is used
//! to find candidate elements by visible text / aria-label, and
//! `Input.insertText` to inject the display name as a synthetic IME
//! event so Meet's React-controlled `<input>` actually picks it up.
//!
//! The whole sequence is best-effort: if any phase times out we log and
//! bail without crashing the window — the user can finish joining
//! manually. Future work: emit lifecycle events back to the frontend so
//! the UI can show "asking host…" / "joined" status.
//!
//! ## Cancellation
//!
//! [`spawn`] returns a [`tokio::task::AbortHandle`] that the caller must
//! store and abort when the associated Meet window is closing. Without
//! cancellation the scanner's CDP polling loops (NAME_INPUT_BUDGET +
//! JOIN_BUTTON_BUDGET, up to 60 s total) keep WebSocket connections open
//! to the CEF debugging endpoint. CEF waits for all active CDP sessions
//! to detach before completing renderer shutdown, so an un-cancelled
//! scanner delays the [`tauri::WindowEvent::Destroyed`] event — and
//! therefore the `meet-call:closed` frontend event — by up to 60 s.
//! See [`crate::meet_call::meet_call_close_window`] for the abort site.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use crate::cdp::{self, CdpConn};

/// Wait at most this long for CEF to surface the new Meet page target
/// after `WebviewWindowBuilder::build()` returns. CEF lazy-creates the
/// renderer-side target a few hundred ms after the host-side window is
/// ready.
const TARGET_DISCOVERY_BUDGET: Duration = Duration::from_secs(20);
const TARGET_DISCOVERY_INTERVAL: Duration = Duration::from_millis(500);

/// Per-phase polling budgets. With the mascot fake-camera flag set
/// process-wide in `lib.rs`, Meet sees a "real" webcam and does NOT
/// show the "Continue without microphone and camera" screen at all,
/// so the device-check phase becomes a quick best-effort probe rather
/// than a meaningful wait. We still keep the phase in case a future
/// build runs without the fake-camera flag (or the Y4M failed to
/// rasterize), but cap it tight so the join flow doesn't stall.
const DEVICE_CHECK_BUDGET: Duration = Duration::from_secs(6);
const NAME_INPUT_BUDGET: Duration = Duration::from_secs(30);
const JOIN_BUTTON_BUDGET: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Spawn the CDP-driven join automation and return an abort handle.
///
/// The caller **must** call [`tokio::task::AbortHandle::abort`] on the
/// returned handle when the Meet window is being torn down. Without
/// cancellation the scanner's polling loops hold CDP connections open and
/// delay CEF renderer shutdown by up to `NAME_INPUT_BUDGET +
/// JOIN_BUTTON_BUDGET` (60 s). See the module-level doc for details.
///
/// `meet_url` is the exact normalised URL the window was navigated to;
/// the scanner uses it as a target-URL prefix so two concurrent calls
/// each attach to their own CEF target instead of cross-controlling.
pub fn spawn<R: Runtime>(
    app: AppHandle<R>,
    request_id: String,
    meet_url: String,
    display_name: String,
) -> tokio::task::AbortHandle {
    // Use tokio::spawn (not tauri::async_runtime::spawn) so we get a
    // JoinHandle whose abort_handle() we can return to the caller.
    let handle = tokio::spawn(async move {
        match run(&request_id, &meet_url, &display_name).await {
            Ok(()) => {
                log::info!("[meet-scanner] join sequence completed request_id={request_id}");
                // Now that the scanner has clicked "Ask to join" and CEF
                // has the meeting page laid out, hide the window so the
                // user never sees the bot's Meet UI. The renderer keeps
                // its backing surface (orderOut: rather than release),
                // so the audio + camera bridges and the meet-agent
                // CDP session continue to function while the bot is
                // off-screen.
                let label = crate::meet_call::window_label_for(&request_id);
                if let Some(window) = app.get_webview_window(&label) {
                    if let Err(err) = window.hide() {
                        log::warn!(
                            "[meet-scanner] post-join hide failed request_id={request_id} err={err}"
                        );
                    } else {
                        log::info!(
                            "[meet-scanner] post-join hide ok request_id={request_id}"
                        );
                    }
                }
            }
            Err(err) => {
                log::warn!("[meet-scanner] join sequence aborted request_id={request_id} err={err}")
            }
        }
    });
    handle.abort_handle()
}

async fn run(request_id: &str, meet_url: &str, display_name: &str) -> Result<(), String> {
    let (mut cdp, session) = wait_for_meet_target(meet_url).await?;
    log::info!("[meet-scanner] attached to meet target request_id={request_id} session={session}");

    // `Runtime.enable` is required before `Runtime.evaluate` returns
    // structured results in some CEF builds. `Page.enable` is harmless
    // and gives us frame-lifecycle events for free if a future PR wants
    // them. Both are best-effort — if they fail we still try to evaluate.
    let _ = cdp.call("Page.enable", json!({}), Some(&session)).await;
    let _ = cdp.call("Runtime.enable", json!({}), Some(&session)).await;

    // Phase 1 — dismiss the device-check screen.
    //
    // Meet's exact copy varies by region/A-B test; we try the canonical
    // English variants. The button is usually `[role="button"]` not
    // `<button>`, so `wait_and_click_text` looks at both.
    if let Err(err) = wait_and_click_text(
        &mut cdp,
        &session,
        &[
            "Continue without microphone and camera",
            "Continue without microphone",
            "Continue without camera",
        ],
        DEVICE_CHECK_BUDGET,
    )
    .await
    {
        log::info!("[meet-scanner] device-check dismissal not needed or unavailable: {err}");
    }

    // Phase 2 — type the display name.
    type_into_named_input(&mut cdp, &session, "Your name", display_name).await?;

    // Phase 2.5 — flip the camera + mic toggles ON.
    //
    // Meet defaults camera + mic OFF for new participants. If we click
    // "Ask to join" without flipping them, the bot joins muted with no
    // camera — Meet never calls getUserMedia, the audio + camera bridges
    // have nothing to intercept, the mascot tile shows initials instead
    // of the mascot canvas, and the speak_pump can't push synthesized
    // PCM into a live mic track. Both toggles use `aria-label` (no
    // visible text) so wait_and_click_text isn't enough; use a
    // dedicated aria-label matcher.
    //
    // Best-effort: if no match is found in the budget, dump the page's
    // current aria-labels so we can extend the matcher next iteration.
    if let Err(err) = click_by_aria_label(
        &mut cdp,
        &session,
        &[
            "turn on camera",
            "camera is off",
            "turn camera on",
            "turn camera off",
            "camera (cmd+e)",
            "camera off",
        ],
        Duration::from_secs(12),
    )
    .await
    {
        log::warn!("[meet-scanner] camera toggle ON not clicked: {err}");
        dump_aria_labels(&mut cdp, &session, "camera|video").await;
    }
    if let Err(err) = click_by_aria_label(
        &mut cdp,
        &session,
        &[
            "turn on microphone",
            "turn on mic",
            "microphone is off",
            "mic is off",
            "turn microphone on",
            "turn off microphone",
            "turn off mic",
            "microphone (cmd+d)",
            "mic (cmd+d)",
            "microphone off",
        ],
        Duration::from_secs(12),
    )
    .await
    {
        log::warn!("[meet-scanner] mic toggle ON not clicked: {err}");
        dump_aria_labels(&mut cdp, &session, "mic|microphone|audio").await;
    }

    // Phase 3 — request to join.
    wait_and_click_text(
        &mut cdp,
        &session,
        &["Ask to join", "Join now"],
        JOIN_BUTTON_BUDGET,
    )
    .await?;

    Ok(())
}

/// Dump the page's aria-labels that match a JS regex pattern so we can
/// inspect what Meet actually exposes after a failed
/// [`click_by_aria_label`]. Best-effort, swallows all CDP errors.
async fn dump_aria_labels(cdp: &mut CdpConn, session: &str, pattern: &str) {
    let pattern_js =
        serde_json::to_string(pattern).unwrap_or_else(|_| "\"camera\"".to_string());
    let expression = format!(
        r#"
        (() => {{
          const re = new RegExp({pattern_js}, "i");
          const nodes = document.querySelectorAll('[aria-label]');
          const hits = [];
          for (const el of nodes) {{
            const aria = el.getAttribute('aria-label') || '';
            if (!re.test(aria)) continue;
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute('role') || '';
            const dataTip = el.getAttribute('data-tooltip') || '';
            const rect = el.getBoundingClientRect();
            const visible = rect.width > 0 && rect.height > 0;
            hits.push({{ aria, tag, role, dataTip, visible }});
            if (hits.length >= 24) break;
          }}
          return hits;
        }})()
        "#
    );
    let res = match cdp
        .call(
            "Runtime.evaluate",
            json!({ "expression": expression, "returnByValue": true }),
            Some(session),
        )
        .await
    {
        Ok(v) => v,
        Err(err) => {
            log::info!("[meet-scanner] aria-label dump failed: {err}");
            return;
        }
    };
    if let Some(arr) = res.get("result").and_then(|r| r.get("value")) {
        log::warn!(
            "[meet-scanner] aria-label dump pattern={} hits={}",
            pattern,
            arr
        );
    }
}

/// Click a button whose `aria-label` matches one of `labels`
/// (case-insensitive substring). Meet's camera + mic toggles have no
/// visible text — they're icon buttons with `aria-label="Turn on
/// camera"` etc. The existing `wait_and_click_text` matches innerText
/// only, so we need a sibling matcher anchored on aria-label.
async fn click_by_aria_label(
    cdp: &mut CdpConn,
    session: &str,
    labels: &[&str],
    budget: Duration,
) -> Result<(), String> {
    let labels_js = serde_json::to_string(labels).map_err(|e| format!("labels json: {e}"))?;
    let expression = format!(
        r#"
        (() => {{
          const labels = {labels_js};
          const want = labels.map(l => l.toLowerCase());
          const candidates = document.querySelectorAll(
            'button, [role="button"], [aria-label]'
          );
          for (const el of candidates) {{
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            if (!aria) continue;
            if (!want.some(w => aria.includes(w))) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            el.scrollIntoView({{ block: 'center', inline: 'center' }});
            el.click();
            return aria;
          }}
          return null;
        }})()
        "#
    );

    let deadline = tokio::time::Instant::now() + budget;
    let mut last_value = Value::Null;
    while tokio::time::Instant::now() < deadline {
        let res = cdp
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": false,
                }),
                Some(session),
            )
            .await?;
        let value = res
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null);
        if value.is_string() {
            log::info!(
                "[meet-scanner] clicked aria-label matching {labels:?} aria={}",
                value.as_str().unwrap_or("")
            );
            return Ok(());
        }
        last_value = value;
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    Err(format!(
        "timeout waiting for aria-label matching {labels:?} (last={last_value})"
    ))
}

/// Poll CEF's target list until a page whose URL starts with `meet_url`
/// shows up, then attach a CDP session to it. Filtering by the full
/// per-call URL prefix (rather than just the host) keeps two concurrent
/// Meet calls from cross-controlling each other when both are open.
async fn wait_for_meet_target(meet_url: &str) -> Result<(CdpConn, String), String> {
    let deadline = tokio::time::Instant::now() + TARGET_DISCOVERY_BUDGET;
    let mut last_err = String::new();
    while tokio::time::Instant::now() < deadline {
        match cdp::connect_and_attach_matching(|t| t.url.starts_with(meet_url)).await {
            Ok(pair) => return Ok(pair),
            Err(err) => {
                last_err = err;
                tokio::time::sleep(TARGET_DISCOVERY_INTERVAL).await;
            }
        }
    }
    Err(format!(
        "timeout waiting for meet.google.com target: {last_err}"
    ))
}

/// Repeatedly evaluate a click-by-text helper in the page until either
/// a click lands or `budget` elapses.
async fn wait_and_click_text(
    cdp: &mut CdpConn,
    session: &str,
    labels: &[&str],
    budget: Duration,
) -> Result<(), String> {
    let labels_js = serde_json::to_string(labels).map_err(|e| format!("labels json: {e}"))?;
    let expression = format!(
        r#"
        (() => {{
          const labels = {labels_js};
          const want = labels.map(l => l.toLowerCase());
          const candidates = document.querySelectorAll(
            'button, [role="button"], a[role="button"]'
          );
          for (const el of candidates) {{
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
            const text = ((el.innerText || el.textContent) || '').trim().toLowerCase();
            if (!text) continue;
            if (!want.some(w => text.includes(w))) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            el.scrollIntoView({{ block: 'center', inline: 'center' }});
            el.click();
            return text;
          }}
          return null;
        }})()
        "#
    );

    let deadline = tokio::time::Instant::now() + budget;
    let mut last_value = Value::Null;
    while tokio::time::Instant::now() < deadline {
        let res = cdp
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": false,
                }),
                Some(session),
            )
            .await?;
        let value = res
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null);
        if value.is_string() {
            log::info!(
                "[meet-scanner] clicked element matching {labels:?} text={}",
                value.as_str().unwrap_or("")
            );
            return Ok(());
        }
        last_value = value;
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    Err(format!(
        "timeout waiting for clickable element matching {labels:?} (last={last_value})"
    ))
}

/// Focus an `<input>` whose `aria-label` or `placeholder` contains
/// `hint`, then dispatch the supplied text via `Input.insertText` so
/// Meet's React-controlled input picks it up as a real keystroke.
async fn type_into_named_input(
    cdp: &mut CdpConn,
    session: &str,
    hint: &str,
    text: &str,
) -> Result<(), String> {
    let hint_js = serde_json::to_string(hint).map_err(|e| format!("hint json: {e}"))?;
    let focus_expr = format!(
        r#"
        (() => {{
          const hint = {hint_js}.toLowerCase();
          const inputs = document.querySelectorAll('input');
          for (const inp of inputs) {{
            const t = (inp.getAttribute('type') || 'text').toLowerCase();
            if (t !== 'text' && t !== 'search') continue;
            const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
            const ph = (inp.placeholder || '').toLowerCase();
            if (!aria.includes(hint) && !ph.includes(hint)) continue;
            inp.focus();
            inp.click();
            // Clear any value already there so we don't append to a
            // half-typed name from a previous attempt.
            try {{ inp.select(); }} catch (_) {{}}
            return true;
          }}
          return false;
        }})()
        "#
    );

    let deadline = tokio::time::Instant::now() + NAME_INPUT_BUDGET;
    while tokio::time::Instant::now() < deadline {
        let res = cdp
            .call(
                "Runtime.evaluate",
                json!({ "expression": focus_expr, "returnByValue": true }),
                Some(session),
            )
            .await?;
        let focused = res
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if focused {
            cdp.call("Input.insertText", json!({ "text": text }), Some(session))
                .await?;
            log::info!(
                "[meet-scanner] inserted display name (hint={hint} chars={})",
                text.chars().count()
            );
            return Ok(());
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    Err(format!("timeout waiting for input matching hint={hint}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_constants_are_sane() {
        // The total scanner budget (discovery + phases) should stay well
        // under 120 s so it never outlasts a full meet session or a build
        // timeout. This assertion catches accidental inflation.
        let total =
            TARGET_DISCOVERY_BUDGET + DEVICE_CHECK_BUDGET + NAME_INPUT_BUDGET + JOIN_BUTTON_BUDGET;
        assert!(
            total <= Duration::from_secs(120),
            "total scanner budget {total:?} exceeds 120 s — check if constants were accidentally inflated"
        );
    }

    #[tokio::test]
    async fn abort_handle_cancels_spawned_task() {
        // spawn a long-running task, abort it immediately, and assert it
        // was cancelled before completing normally.
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };

        let completed = Arc::new(AtomicBool::new(false));
        let completed_clone = completed.clone();

        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(60)).await;
            completed_clone.store(true, Ordering::SeqCst);
        });
        let abort = handle.abort_handle();

        abort.abort();

        // Give the runtime a tick to process the abort.
        tokio::task::yield_now().await;

        assert!(
            !completed.load(Ordering::SeqCst),
            "task must not have completed after abort"
        );
        assert!(
            handle.await.unwrap_err().is_cancelled(),
            "awaited task must report cancellation"
        );
    }
}
