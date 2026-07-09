//! Unit coverage for the device-side hosted-orchestration client: the world-diff
//! observation buffer, the world-observation note builder, and the evict-effect
//! parsing. These paths need no backend, so they run in the plain integration
//! crate (the root crate's `cfg(test)` build is gated elsewhere).

use openhuman_core::openhuman::orchestration::effect_executor::{
    effect_result_frame, is_duplicate_call, parse_evict,
};
use openhuman_core::openhuman::orchestration::store;
use openhuman_core::openhuman::orchestration::world_model::observe_ingest_note;

// ── world_model: bounded, single-line, never leaks the body ───────────────────

#[test]
fn observe_ingest_note_summarises_without_the_body() {
    let note = observe_ingest_note("h-1", "@peer", "dm", "super secret plaintext body");
    // The body is summarised to a char count, never copied.
    assert!(!note.contains("super secret plaintext body"));
    assert!(note.contains("@peer"));
    assert!(note.contains("h-1"));
    assert!(note.contains("chars"));
    // Single line, bounded.
    assert!(!note.contains('\n'));
    assert!(note.chars().count() <= 240);
}

#[test]
fn observe_ingest_note_defaults_empty_session_and_kind() {
    let note = observe_ingest_note("", "@peer", "", "");
    assert!(note.contains("master")); // empty session → master
    assert!(note.contains("message")); // empty kind → message
    assert!(note.contains("empty")); // empty body → "empty"
}

#[test]
fn observe_ingest_note_collapses_newlines_and_clamps() {
    let long = "x".repeat(5000);
    let note = observe_ingest_note("h-1", "line1\nline2", "dm", &long);
    assert!(!note.contains('\n'));
    assert!(note.chars().count() <= 240);
}

// ── evict effect parsing + ack frame ──────────────────────────────────────────

#[test]
fn parse_evict_reads_the_backend_frame_shape() {
    let frame = serde_json::json!({
        "cycleId": "cyc:1",
        "callId": "cyc:1:evict:0",
        "sessionId": "h-1",
        "entries": [
            { "cycleId": "cyc:0", "summary": "user asked about billing" },
            { "cycleId": "cyc:1", "summary": "resolved via refund" },
        ],
    });
    let effect = parse_evict(&frame).expect("valid evict frame");
    assert_eq!(effect.call_id, "cyc:1:evict:0");
    assert_eq!(effect.session_id, "h-1");
    assert_eq!(effect.entries.len(), 2);
    assert_eq!(effect.entries[0].summary, "user asked about billing");
}

#[test]
fn parse_evict_rejects_a_frame_without_call_id() {
    let frame = serde_json::json!({ "sessionId": "h-1", "entries": [] });
    assert!(parse_evict(&frame).is_err());
}

#[test]
fn effect_result_frame_has_the_ack_shape() {
    let ok = effect_result_frame("c-1", true, None);
    assert_eq!(ok["callId"], "c-1");
    assert_eq!(ok["ok"], true);
    let err = effect_result_frame("c-2", false, Some("boom"));
    assert_eq!(err["ok"], false);
    assert_eq!(err["error"], "boom");
}

#[test]
fn is_duplicate_call_is_true_only_on_the_second_sight() {
    let id = "unique-call-id-orchestration-hosted-test";
    assert!(!is_duplicate_call(id), "first sight is not a duplicate");
    assert!(is_duplicate_call(id), "second sight is a duplicate");
}

// ── world_obs device buffer round-trip ────────────────────────────────────────

#[test]
fn world_obs_buffer_appends_monotonic_drains_fifo_and_deletes() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().to_path_buf();

    // Append three observations; seq is globally monotonic.
    let (s1, s2, s3) = store::with_connection(&ws, |conn| {
        let s1 = store::append_world_obs(conn, "h-1", "note-1", 100)?;
        let s2 = store::append_world_obs(conn, "h-1", "note-2", 200)?;
        let s3 = store::append_world_obs(conn, "h-2", "note-3", 300)?;
        Ok((s1, s2, s3))
    })
    .unwrap();
    assert_eq!((s1, s2, s3), (1, 2, 3));

    // Drain FIFO by insert order.
    let rows = store::with_connection(&ws, |conn| store::drain_world_obs(conn, 10)).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].note, "note-1");
    assert_eq!(rows[0].session_id, "h-1");
    assert_eq!(rows[2].session_id, "h-2");

    // Delete the first two; the third remains buffered (retry semantics).
    let keep = rows[2].id;
    store::with_connection(&ws, |conn| {
        store::delete_world_obs(conn, &[rows[0].id, rows[1].id])
    })
    .unwrap();
    let remaining = store::with_connection(&ws, |conn| store::drain_world_obs(conn, 10)).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, keep);
    assert_eq!(remaining[0].note, "note-3");
}

#[test]
fn world_obs_drain_respects_the_limit() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().to_path_buf();
    store::with_connection(&ws, |conn| {
        for i in 0..5 {
            store::append_world_obs(conn, "h-1", &format!("n{i}"), i)?;
        }
        Ok(())
    })
    .unwrap();
    let rows = store::with_connection(&ws, |conn| store::drain_world_obs(conn, 2)).unwrap();
    assert_eq!(rows.len(), 2);
}
