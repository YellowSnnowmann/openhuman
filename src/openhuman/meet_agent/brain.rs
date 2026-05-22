//! Turn orchestration: STT → LLM → TTS.
//!
//! ## Pipeline
//!
//! When [`session::Vad`] reports `EndOfUtterance`, [`run_turn`] drains
//! the inbound buffer and runs three serial stages:
//!
//! 1. **STT** — wrap the PCM16LE samples in a WAV container and post
//!    to [`crate::openhuman::voice::cloud_transcribe`]. Returns the
//!    transcribed text (or `Err` on transport / auth failure).
//!
//! 2. **LLM** — send a tiny chat-completions request through
//!    [`crate::api::BackendOAuthClient`] with a "live meeting agent"
//!    system prompt and the transcript as the user message. Returns a
//!    short reply (or empty string when the agent decides to stay
//!    silent).
//!
//! 3. **TTS** — feed the reply text into
//!    [`crate::openhuman::voice::reply_speech`] requesting
//!    `output_format = "pcm_16000"`. Decode the base64 PCM bytes back
//!    into `Vec<i16>` and enqueue on the session's outbound queue.
//!
//! ## Fallback
//!
//! When the backend session token is missing (the most common reason
//! a stage fails outside production: tests, no-network smoke runs),
//! we fall back to deterministic stubs so the loop still produces an
//! audible blip and the unit tests stay network-free. Real
//! transport / 5xx errors are *not* swallowed — they surface as
//! `Note` events so a real-call failure is visible in the transcript
//! log, not silently degraded to a stub.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};
use std::time::Duration;

use super::session::registry;
use super::types::{SessionEvent, SessionEventKind};
use super::wav;

/// Wall-clock ceiling on one agentic turn. Tool iterations + LLM call
/// can run 10s+; 20s is comfortable for calendar / memory lookups but
/// short enough that we fall back to a polite "let me get back to
/// you" instead of leaving the meet participant in silence.
const AGENTIC_TURN_TIMEOUT_SECS: u64 = 20;

/// How many of the most recent `Heard` / `Spoke` events we feed back
/// into the LLM as rolling conversation context. 12 ≈ a few minutes of
/// captioned dialogue — enough for the model to follow a thread without
/// blowing the prompt budget.
const CONTEXT_EVENT_WINDOW: usize = 12;
/// Spoken-reply ceiling. Each token is roughly ¾ of a word, so 80
/// tokens ≈ ~60 spoken words ≈ ~12 seconds. The system prompt asks for
/// one short sentence, but reasoning-style backends ignore soft length
/// hints and emit 800+ char monologues. Hard token cap keeps the bot
/// interruptible regardless of model behaviour.
const REPLY_MAX_TOKENS: u32 = 80;
/// ElevenLabs model. `eleven_turbo_v2_5` strikes the best
/// quality/latency balance; the older default the backend would pick
/// (`eleven_monolingual_v1`) sounds noticeably flatter.
const TTS_MODEL_ID: &str = "eleven_turbo_v2_5";

/// Hard ceiling on reply characters fed to TTS. The LLM is asked to be
/// concise but reasoning models still emit 800+ char paragraphs. Cap
/// drops everything past the first sentence boundary at-or-before
/// this index, falling back to a raw char cut when no boundary fits.
/// ~25s of speech at average prosody — keeps the bot interruptible
/// and prevents the "60s monologue / can't talk over it" loop.
const MAX_TTS_CHARS: usize = 400;

/// Minimum samples below which we skip the brain turn entirely.
/// 250 ms @ 16 kHz — under this, VAD almost certainly fired on a
/// transient (cough, click) rather than real speech.
const MIN_TURN_SAMPLES: usize = 4_000;
/// Re-exported from `ops` so any drift (if we ever loosen the
/// boundary check) immediately breaks the WAV / duration math here
/// at compile time. Today the same constant is used in both places —
/// the ops boundary check rejects anything else outright.
const SAMPLE_RATE_HZ: u32 = super::ops::REQUIRED_SAMPLE_RATE;

/// Caption-driven turn. Drains the session's pending wake-word prompt
/// (assembled by `session::note_caption`) and runs LLM → TTS → enqueue
/// outbound. Skips STT entirely — the captions are already text.
///
/// We give the user a short window (`CAPTION_TURN_DELAY_MS`) after the
/// wake word fires so multi-caption utterances ("hey openhuman …
/// what's the weather like in paris") have a chance to assemble
/// before we hit the LLM. The shell calls this on every caption
/// push that flagged the wake word; subsequent calls before the
/// delay expires are coalesced via the session's `wake_active` flag.
pub async fn run_caption_turn(request_id: &str) -> Result<bool, String> {
    // Wait briefly so a multi-fragment wake utterance ("hey openhuman
    // what's the weather like in paris" arriving as 2-3 captions) has
    // a chance to assemble before we drain the prompt.
    tokio::time::sleep(std::time::Duration::from_millis(CAPTION_TURN_DELAY_MS)).await;

    // When wake fires from a bare "hey openhuman" with no tail, the
    // session returns None from take_pending_prompt — there's nothing
    // to feed the LLM. Previously we silently bailed (`return Ok(false)`)
    // which made the bot look broken to the user. Treat empty-tail wake
    // as a "say hi back" greeting cue: synthesize a short ack so the
    // user gets audible proof that the caption→wake→speak loop is
    // wired up end-to-end.
    //
    // Also: drop any queued outbound PCM from the previous turn.
    // Reasoning-model replies can run 60+ seconds; if the user re-fires
    // the wake mid-reply we need to stop the old speech rather than
    // play the entire backlog before the new reply starts. This makes
    // the bot interruptible from the user's side.
    let (prompt, history, was_bare_wake) = match registry().with_session(request_id, |s| {
        s.cancel_outbound();
        let prompt = s.take_pending_prompt();
        let history = recent_dialog_history(s.events(), CONTEXT_EVENT_WINDOW);
        (prompt, history)
    })? {
        (Some(p), h) => (p, h, false),
        (None, h) => {
            log::info!(
                "[meet-agent] caption turn bare-wake (no tail) request_id={request_id} — replying with greeting ack"
            );
            ("hello".to_string(), h, true)
        }
    };
    log::info!(
        "[meet-agent] caption turn start request_id={request_id} prompt_chars={} history_msgs={} bare_wake={}",
        prompt.chars().count(),
        history.len(),
        was_bare_wake,
    );

    // Route the turn through the FULL orchestrator agent first — it
    // owns the user's connected integrations, memory tree, MCP
    // clients and skills, so it can actually answer "is my Friday
    // free", "what did Alice say about the deploy", etc. Falls back
    // to the bare chat-completions path on orchestrator build /
    // timeout / RPC error so a config-degraded environment still
    // produces audible output instead of dead air.
    let reply_text = match llm_meeting_agentic(&prompt, request_id).await {
        Ok(text) => text,
        Err(agentic_err) => {
            log::warn!(
                "[meet-agent] agentic turn failed, falling back to basic LLM request_id={request_id} err={agentic_err}"
            );
            match llm_meeting_basic(&prompt, &history).await {
                Ok(text) => text,
                Err(basic_err) => {
                    log::warn!(
                        "[meet-agent] basic LLM also failed request_id={request_id} err={basic_err}"
                    );
                    let _ = registry().with_session(request_id, |s| {
                        s.record_event(
                            SessionEventKind::Note,
                            format!(
                                "both LLM paths failed (agentic: {agentic_err}; basic: {basic_err})"
                            ),
                        );
                    });
                    pick_ack_phrase(&prompt).to_string()
                }
            }
        }
    };

    let synthesized = if reply_text.trim().is_empty() {
        Vec::new()
    } else {
        match tts(&reply_text).await {
            Ok(samples) => samples,
            Err(err) => {
                log::warn!(
                    "[meet-agent] caption-turn TTS failed request_id={request_id} err={err}"
                );
                let _ = registry().with_session(request_id, |s| {
                    s.record_event(
                        SessionEventKind::Note,
                        format!("TTS failure (using stub): {err}"),
                    );
                });
                stub_tts(&reply_text).await
            }
        }
    };

    registry().with_session(request_id, |s| {
        s.record_event(SessionEventKind::Heard, prompt.clone());
        if !reply_text.is_empty() {
            s.record_event(SessionEventKind::Spoke, reply_text.clone());
            if !synthesized.is_empty() {
                s.enqueue_outbound_pcm(&synthesized, true);
            }
        } else {
            s.record_event(
                SessionEventKind::Note,
                "agent declined to respond".to_string(),
            );
        }
        s.turn_count += 1;
    })?;

    log::info!(
        "[meet-agent] caption turn done request_id={request_id} reply_chars={} synth_samples={}",
        reply_text.chars().count(),
        synthesized.len()
    );
    Ok(true)
}

/// Delay between wake-word match and prompt drain. Long enough that
/// 2-3 caption fragments can join up; short enough that the user
/// doesn't experience awkward silence after they stop talking.
const CAPTION_TURN_DELAY_MS: u64 = 1_500;

/// Canned acknowledgements the agent speaks out loud after capturing
/// a note. Short, varied so consecutive notes don't sound robotic.
/// Selected by hashing the prompt so the same dictation reliably
/// produces the same ack (helpful for tests + debugging) while still
/// rotating across the set in a normal conversation.
const ACK_PHRASES: &[&str] = &["Got it.", "Noted.", "Adding that.", "On it.", "Captured."];

fn pick_ack_phrase(prompt: &str) -> &'static str {
    if prompt.trim().is_empty() {
        return "";
    }
    let h: u32 = prompt.bytes().fold(0u32, |a, b| a.wrapping_add(b as u32));
    ACK_PHRASES[(h as usize) % ACK_PHRASES.len()]
}

/// Fire one brain turn for the named session. Returns `Ok(true)` when a
/// turn actually ran, `Ok(false)` when the inbound buffer was below the
/// floor.
pub async fn run_turn(request_id: &str) -> Result<bool, String> {
    let (drained, history) = registry().with_session(request_id, |s| {
        let drained = s.drain_inbound();
        let history = recent_dialog_history(s.events(), CONTEXT_EVENT_WINDOW);
        (drained, history)
    })?;
    if drained.len() < MIN_TURN_SAMPLES {
        log::debug!(
            "[meet-agent] skipping turn request_id={request_id} samples={}",
            drained.len()
        );
        return Ok(false);
    }

    log::info!(
        "[meet-agent] turn start request_id={request_id} samples={}",
        drained.len()
    );

    // ─── STT ────────────────────────────────────────────────────────
    let heard = match stt(&drained).await {
        Ok(text) if text.trim().is_empty() => {
            log::info!("[meet-agent] STT empty, skipping turn request_id={request_id}");
            return Ok(false);
        }
        Ok(text) => text,
        Err(err) => {
            log::warn!("[meet-agent] STT failed request_id={request_id} err={err}");
            // Record a Note so the transcript log makes the failure
            // visible to whoever's looking at logs.
            let _ = registry().with_session(request_id, |s| {
                s.record_event(
                    SessionEventKind::Note,
                    format!("STT failure (using stub): {err}"),
                );
            });
            stub_stt(&drained).await
        }
    };
    log::info!(
        "[meet-agent] STT request_id={request_id} text_chars={}",
        heard.chars().count()
    );

    // ─── LLM (agentic-first, basic-fallback) ───────────────────────
    let reply_text = match llm_meeting_agentic(&heard, request_id).await {
        Ok(text) => text,
        Err(agentic_err) => {
            log::warn!(
                "[meet-agent] STT-path agentic failed, falling back request_id={request_id} err={agentic_err}"
            );
            match llm_meeting_basic(&heard, &history).await {
                Ok(text) => text,
                Err(basic_err) => {
                    log::warn!(
                        "[meet-agent] STT-path basic LLM also failed request_id={request_id} err={basic_err}"
                    );
                    let _ = registry().with_session(request_id, |s| {
                        s.record_event(
                            SessionEventKind::Note,
                            format!(
                                "both LLM paths failed (agentic: {agentic_err}; basic: {basic_err})"
                            ),
                        );
                    });
                    stub_llm(&heard).await
                }
            }
        }
    };

    // ─── TTS ────────────────────────────────────────────────────────
    let synthesized = if reply_text.trim().is_empty() {
        Vec::new()
    } else {
        match tts(&reply_text).await {
            Ok(samples) => samples,
            Err(err) => {
                log::warn!("[meet-agent] TTS failed request_id={request_id} err={err}");
                let _ = registry().with_session(request_id, |s| {
                    s.record_event(
                        SessionEventKind::Note,
                        format!("TTS failure (using stub): {err}"),
                    );
                });
                stub_tts(&reply_text).await
            }
        }
    };

    registry().with_session(request_id, |s| {
        s.record_event(SessionEventKind::Heard, heard.clone());
        if !reply_text.is_empty() {
            s.record_event(SessionEventKind::Spoke, reply_text.clone());
            if !synthesized.is_empty() {
                s.enqueue_outbound_pcm(&synthesized, true);
            }
        } else {
            s.record_event(
                SessionEventKind::Note,
                "agent declined to respond".to_string(),
            );
        }
        s.turn_count += 1;
    })?;

    log::info!(
        "[meet-agent] turn done request_id={request_id} reply_chars={} synth_samples={}",
        reply_text.chars().count(),
        synthesized.len()
    );
    Ok(true)
}

// ─── Real adapters ──────────────────────────────────────────────────

async fn stt(samples: &[i16]) -> Result<String, String> {
    use crate::openhuman::voice::cloud_transcribe::{transcribe_cloud, CloudTranscribeOptions};

    let config = crate::openhuman::config::ops::load_config_with_timeout().await?;
    let wav_bytes = wav::pack_pcm16le_mono_wav(samples, SAMPLE_RATE_HZ);
    let audio_b64 = B64.encode(&wav_bytes);
    let opts = CloudTranscribeOptions {
        mime_type: Some("audio/wav".to_string()),
        file_name: Some("meet-agent.wav".to_string()),
        ..Default::default()
    };
    let outcome = transcribe_cloud(&config, &audio_b64, &opts).await?;
    let text = outcome.value.text.clone();
    Ok(text)
}

/// System prompt for the live meeting agent. Pushes the model toward
/// (a) recognising whether the latest utterance is genuinely directed
/// at it (intent classification — emit empty string when not), and
/// (b) responding conversationally and concisely when it is.
const MEETING_SYSTEM_PROMPT: &str = "\
You are OpenHuman, joining a live Google Meet call by voice. Every word you \
produce will be spoken aloud over the call. The transcript shows `user` lines \
(humans on the call, sometimes prefixed with a name) and `assistant` lines \
(things you previously said out loud).\n\
\n\
STRICT OUTPUT RULES — these are non-negotiable. The output is fed DIRECTLY \
into TTS and spoken aloud verbatim. Any meta-text becomes audible bot \
gibberish on a live call.\n\
1. Output ONE sentence. Maximum 25 spoken words.\n\
2. Plain spoken English. No markdown. No bullets. No code. No emoji.\n\
3. NO chain-of-thought. NO reasoning. NO planning. NO <think> blocks. NO \
preamble. NEVER write phrases like \"We need to…\", \"I should…\", \"Let me…\", \
\"The user said…\", \"This is a greeting…\", \"So I should respond with…\", \
\"My response is…\". Output ONLY the final answer that the user should hear.\n\
4. Never repeat what the user said. Never narrate what you are about to do.\n\
5. If the latest user line is not directly addressed to you, output the empty \
string. Do not respond to side conversations or ambient speech.\n\
6. Examples — good vs bad:\n\
   User: \"hello\" → GOOD: \"Hey there.\"  BAD: \"The user said hello, so I should respond with a greeting.\"\n\
   User: \"what's the time\" → GOOD: \"I don't have a clock right now.\"  BAD: \"We need to generate a single sentence. The user is asking the time.\"\n\
\n\
Address-detection: respond when the user names you (\"OpenHuman\", \"hey \
openhuman\"), asks a direct question of you, or gives a direct command \
(remember, summarise, look up). Otherwise stay silent.\n\
\n\
For unanswerable questions: say so in one sentence (\"I don't know that off \
the top of my head\") instead of guessing or stalling.\n\
For dictation / note requests: a 2-3 word ack (\"Got it.\", \"Noted.\"). Don't \
read the note back.\n\
";

/// Voice-frontend system-prompt directive prepended to the user
/// utterance before it reaches the orchestrator. The orchestrator
/// already has its own persona, tool catalogue, memory loader and
/// connected integrations; this addendum just tells it the answer is
/// going to be spoken aloud verbatim so it should reply in one short
/// spoken sentence with no markdown / no chain-of-thought / no
/// preamble. Wrapped in a delimiter so the orchestrator can't confuse
/// the directive with the user's actual utterance.
const MEET_VOICE_DIRECTIVE: &str = "MEETING VOICE MODE: This conversation is happening live over voice in a Google Meet call. Every word of your reply will be passed VERBATIM to TTS and spoken aloud. Therefore: answer in ONE short spoken sentence, max 25 words, plain spoken English, no markdown, no bullets, no code, no preamble (do not say \"I should…\", \"Let me…\", \"We need to…\", \"The user said…\"). Tool-use is great — call tools when needed — but only the final spoken reply should appear in your output. If the user is not directly addressing you, output an empty string and stay silent.";

/// First 12 chars of `request_id`, for log scoping. UUID prefixes are
/// unique enough at one-meet-at-a-time to keep transcripts apart.
fn short_id(id: &str) -> String {
    id.chars().take(12).collect()
}

/// Route the meeting utterance through the FULL orchestrator agent —
/// same path the chat UI and the webview meet handoff use. The
/// orchestrator inherits the user's connected integrations, memory
/// tree, MCP clients, skills, and the project-wide tool registry, so
/// "is my Friday evening free", "did anyone in #eng ping me about
/// the deploy", "remind me to mail Alice tomorrow" all answer with
/// real data — not a guess from the model's training prior.
///
/// We rebuild the Agent per turn (cheap relative to the LLM call
/// itself, since the registry is initialised once at startup) and
/// wrap `run_single` in a 20s timeout so a slow tool iteration
/// doesn't leave the meeting participant in silence indefinitely.
///
/// Errors propagate to the caller, which falls back to the bare
/// chat-completions path (`llm_meeting_basic`) so a config /
/// registry / token issue degrades to a polite reply instead of
/// dead air.
async fn llm_meeting_agentic(prompt: &str, request_id: &str) -> Result<String, String> {
    use crate::openhuman::agent::harness::session::Agent;

    let config = crate::openhuman::config::ops::load_config_with_timeout().await?;

    // Use the with_profile builder — same canonical path the web
    // channel (chat UI) uses at channels/providers/web.rs:1570. This
    // is what wires the user's connected integrations + delegation
    // tools onto the orchestrator. The plain `from_config_for_agent`
    // builds with zero integrations attached. `profile_prompt_suffix`
    // is the established hook for per-channel system-prompt
    // augmentation — the web channel uses it for the locale-reply
    // directive; we use it for the voice-frontend directive.
    let mut agent = Agent::from_config_for_agent_with_profile(
        &config,
        "orchestrator",
        None,
        Some(MEET_VOICE_DIRECTIVE.to_string()),
    )
    .map_err(|e| format!("[meet-agent] orchestrator build failed: {e}"))?;

    // Per-meet event context so the harness scopes its session
    // transcript to this request_id instead of colliding with the
    // chat-UI thread. Without this, two simultaneous orchestrators
    // (chat + meet) share one transcript file.
    agent.set_event_context(format!("meet_{request_id}"), "meet_agent");
    agent.set_agent_definition_name(format!("orchestrator_meet_{}", short_id(request_id)));

    log::info!(
        "[meet-agent] agentic turn dispatch request_id={request_id} prompt_chars={}",
        prompt.chars().count()
    );

    let fut = agent.run_single(prompt);
    let reply = match tokio::time::timeout(
        Duration::from_secs(AGENTIC_TURN_TIMEOUT_SECS),
        fut,
    )
    .await
    {
        Ok(Ok(text)) => text,
        Ok(Err(e)) => {
            return Err(format!("[meet-agent] orchestrator run_single failed: {e}"));
        }
        Err(_elapsed) => {
            log::warn!(
                "[meet-agent] agentic turn timed out request_id={request_id} after {}s — falling back",
                AGENTIC_TURN_TIMEOUT_SECS
            );
            return Err(format!(
                "agentic timeout after {AGENTIC_TURN_TIMEOUT_SECS}s"
            ));
        }
    };

    Ok(strip_for_speech(&reply))
}

/// Build a chat-completions request from rolling meeting history plus
/// the current user prompt, post it through the backend, and return
/// the assistant's reply (trimmed, possibly empty).
///
/// Used as a fallback when the orchestrator path
/// (`llm_meeting_agentic`) cannot be built — missing config,
/// registry not initialised, no session token. The orchestrator path
/// gives memory/tool/integration access; this bare path only gets
/// the rolling caption history. Acceptable degradation so the bot
/// doesn't go silent in a config-degraded environment.
async fn llm_meeting_basic(prompt: &str, history: &[ConversationTurn]) -> Result<String, String> {
    use crate::api::config::effective_backend_api_url;
    use crate::api::jwt::get_session_token;
    use crate::api::BackendOAuthClient;
    use reqwest::Method;

    let config = crate::openhuman::config::ops::load_config_with_timeout().await?;
    let token = get_session_token(&config)
        .map_err(|e| e.to_string())?
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| "no backend session token".to_string())?;

    let api_url = effective_backend_api_url(&config.api_url);
    let client = BackendOAuthClient::new(&api_url).map_err(|e| e.to_string())?;

    let mut messages: Vec<Value> = Vec::with_capacity(history.len() + 2);
    messages.push(json!({ "role": "system", "content": MEETING_SYSTEM_PROMPT }));
    for turn in history {
        messages.push(json!({ "role": turn.role, "content": turn.content }));
    }
    messages.push(json!({ "role": "user", "content": prompt }));

    let body = json!({
        // chat-v1 = conversational non-reasoning model. agentic-v1 /
        // reasoning-v1 leak their chain-of-thought as plain text
        // ("We need to generate a single sentence…") into the response
        // body when streamed without the structured thinking_delta
        // channel — which TTS then reads aloud. chat-v1 produces a
        // direct user-facing answer, which is what we want over voice.
        "model": "chat-v1",
        "temperature": 0.5,
        "max_tokens": REPLY_MAX_TOKENS,
        "messages": messages,
    });

    let raw = client
        .authed_json(
            &token,
            Method::POST,
            "/openai/v1/chat/completions",
            Some(body),
        )
        .await
        .map_err(|e| e.to_string())?;

    let text = extract_chat_completion_text(&raw)
        .ok_or_else(|| format!("unexpected chat completions response: {raw}"))?;
    Ok(strip_for_speech(&text))
}

/// Trim characters that sound bad when read aloud by TTS but routinely
/// leak from a chat-completions response (markdown asterisks, fenced
/// code, leading bullets). Keep punctuation that affects prosody
/// (commas, periods, question marks) intact.
fn strip_for_speech(text: &str) -> String {
    // Strip reasoning-model <think>...</think> blocks before we strip
    // markdown. DeepSeek / GMI / qwen-style reasoning models emit
    // their internal chain-of-thought wrapped in <think>...</think>
    // tags ahead of the user-facing reply. Without this, TTS reads
    // the entire monologue aloud — which on a 60s+ reasoning trace
    // produces a minute of bot speech the user never asked for.
    // Multiple non-overlapping blocks are stripped in sequence; an
    // unclosed <think> at the end (truncated output) drops everything
    // from the tag onwards.
    let mut cleaned = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        match rest.find("<think>") {
            Some(open) => {
                cleaned.push_str(&rest[..open]);
                let after = &rest[open + "<think>".len()..];
                match after.find("</think>") {
                    Some(close) => {
                        rest = &after[close + "</think>".len()..];
                    }
                    None => {
                        // Unclosed tag → drop the rest as reasoning.
                        break;
                    }
                }
            }
            None => {
                cleaned.push_str(rest);
                break;
            }
        }
    }
    let text = cleaned.trim();

    let mut out = String::with_capacity(text.len());
    let mut in_code = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        let cleaned: String = trimmed
            .trim_start_matches(|c: char| c == '-' || c == '*' || c == '#' || c == '>')
            .trim()
            .chars()
            .filter(|c| !matches!(c, '*' | '`' | '_' | '#'))
            .collect();
        if cleaned.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&cleaned);
    }
    let trimmed = out.trim().to_string();
    let de_reasoned = strip_untagged_reasoning(&trimmed);
    cap_for_speech(&de_reasoned, MAX_TTS_CHARS)
}

/// Strip reasoning-style preamble that reasoning models leak as plain
/// text (no `<think>` tags) — phrases like "We need to generate…",
/// "I should respond with…", "The user said…", "Let me think…".
/// Heuristic: drop sentences whose lowercased trim matches a known
/// reasoning opener; if everything is reasoning, return only the last
/// sentence (final conclusion). If no signal, return input untouched.
fn strip_untagged_reasoning(text: &str) -> String {
    if text.is_empty() {
        return text.to_string();
    }
    const REASONING_OPENERS: &[&str] = &[
        "we need to",
        "we should",
        "i need to",
        "i should",
        "i will",
        "let me ",
        "first,",
        "the user said",
        "the user is",
        "the user asked",
        "the user wants",
        "this is a",
        "this seems",
        "so i should",
        "so the response",
        "so my response",
        "okay, so",
        "alright,",
        "given that",
        "since the user",
        "the assistant",
        "the response should",
        "my response",
        "to respond",
        "responding with",
    ];
    let sentences: Vec<&str> = text
        .split_inclusive(|c: char| matches!(c, '.' | '!' | '?'))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if sentences.is_empty() {
        return text.to_string();
    }
    let kept: Vec<&str> = sentences
        .iter()
        .filter(|s| {
            let lc = s.to_lowercase();
            !REASONING_OPENERS.iter().any(|opener| lc.starts_with(opener))
        })
        .copied()
        .collect();
    if kept.is_empty() {
        // Everything was reasoning — return the last sentence as the
        // probable conclusion, lower-cased openers stripped.
        return sentences.last().map(|s| s.to_string()).unwrap_or_default();
    }
    kept.join(" ")
}

/// Truncate `text` to at most `max_chars` characters, preferring to
/// cut at the last sentence terminator (`.`, `!`, `?`) inside the
/// budget so the TTS doesn't trail off mid-clause. Falls back to a
/// hard char cut + ellipsis when no terminator fits.
fn cap_for_speech(text: &str, max_chars: usize) -> String {
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_string();
    }
    let prefix: String = text.chars().take(max_chars).collect();
    if let Some(idx) = prefix.rfind(['.', '!', '?']) {
        let end = idx + prefix[idx..].chars().next().map(char::len_utf8).unwrap_or(1);
        return prefix[..end].trim_end().to_string();
    }
    let mut out = prefix.trim_end().to_string();
    out.push('…');
    out
}

/// One rolling-history entry handed to the LLM.
#[derive(Debug, Clone)]
struct ConversationTurn {
    role: &'static str,
    content: String,
}

/// Pull the last `window` `Heard`/`Spoke` events from the session log
/// and shape them into chat-completions turns. `Note` events are
/// internal book-keeping (errors, wake-word matches) and are skipped.
fn recent_dialog_history(events: &[SessionEvent], window: usize) -> Vec<ConversationTurn> {
    let mut out: Vec<ConversationTurn> = Vec::with_capacity(window);
    for e in events.iter().rev() {
        if out.len() >= window {
            break;
        }
        let role = match e.kind {
            SessionEventKind::Heard => "user",
            SessionEventKind::Spoke => "assistant",
            SessionEventKind::Note => continue,
        };
        let content = e.text.trim();
        if content.is_empty() {
            continue;
        }
        out.push(ConversationTurn {
            role,
            content: content.to_string(),
        });
    }
    out.reverse();
    out
}

async fn tts(text: &str) -> Result<Vec<i16>, String> {
    use crate::openhuman::voice::reply_speech::{synthesize_reply, ReplySpeechOptions};

    let config = crate::openhuman::config::ops::load_config_with_timeout().await?;
    // Tuned for live conversational speech, not narration:
    //   stability 0.4 — leave room for prosody / inflection. Higher
    //     values (>0.6) flatten the read into the "monotone audiobook"
    //     timbre the previous default produced.
    //   similarity_boost 0.75 — keep the chosen voice's character.
    //   style 0.35 — light expressiveness; too high makes punctuation
    //     swallow words.
    //   use_speaker_boost on — louder, clearer in noisy meetings.
    let voice_settings = json!({
        "stability": 0.4,
        "similarity_boost": 0.75,
        "style": 0.35,
        "use_speaker_boost": true,
    });
    let opts = ReplySpeechOptions {
        // Ask ElevenLabs (via the hosted backend) for raw PCM16LE @
        // 16 kHz so we can feed the result straight into the
        // shell-side bridge with no transcoding.
        output_format: Some("pcm_16000".to_string()),
        model_id: Some(TTS_MODEL_ID.to_string()),
        voice_settings: Some(voice_settings),
        ..Default::default()
    };
    let outcome = synthesize_reply(&config, text, &opts).await?;
    let result = outcome.value;
    let pcm_bytes = B64
        .decode(result.audio_base64.as_bytes())
        .map_err(|e| format!("decode tts base64: {e}"))?;
    if !pcm_bytes.len().is_multiple_of(2) {
        return Err(format!("odd byte length from tts: {}", pcm_bytes.len()));
    }
    Ok(pcm_bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect())
}

fn extract_chat_completion_text(raw: &Value) -> Option<String> {
    raw.get("choices")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|first| first.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|s| s.as_str())
        .map(|s| s.trim().to_string())
}

// ─── Stubs (fallback for tests / no-backend) ────────────────────────

async fn stub_stt(samples: &[i16]) -> String {
    let secs = samples.len() as f32 / SAMPLE_RATE_HZ as f32;
    format!("(heard ~{secs:.1}s of audio)")
}

async fn stub_llm(_heard: &str) -> String {
    "I'm listening.".to_string()
}

async fn stub_tts(text: &str) -> Vec<i16> {
    if text.is_empty() {
        return Vec::new();
    }
    let sample_rate = SAMPLE_RATE_HZ as f32;
    let freq = 440.0_f32;
    let duration_secs = 0.2_f32;
    let count = (sample_rate * duration_secs) as usize;
    (0..count)
        .map(|i| {
            let t = i as f32 / sample_rate;
            (((2.0 * std::f32::consts::PI * freq * t).sin()) * (i16::MAX as f32 * 0.3)) as i16
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openhuman::meet_agent::session::registry;

    #[tokio::test]
    async fn run_turn_skips_short_buffers() {
        registry().start("brain-skip", 16_000).unwrap();
        registry()
            .with_session("brain-skip", |s| {
                s.push_inbound_pcm(&vec![0; 800]); // 50ms — under floor
            })
            .unwrap();
        assert_eq!(run_turn("brain-skip").await.unwrap(), false);
        let _ = registry().stop("brain-skip");
    }

    #[tokio::test]
    async fn run_turn_falls_back_to_stub_without_backend() {
        // No backend session in test env → STT/LLM/TTS all fail and
        // each stage falls back to its stub. The turn still produces
        // a Heard event, a Spoke event, and synthesized PCM, so the
        // smoke-test contract holds.
        registry().start("brain-fallback", 16_000).unwrap();
        registry()
            .with_session("brain-fallback", |s| {
                s.push_inbound_pcm(&vec![1000; 16_000]); // 1s
            })
            .unwrap();
        assert_eq!(run_turn("brain-fallback").await.unwrap(), true);
        registry()
            .with_session("brain-fallback", |s| {
                let kinds: Vec<_> = s.events().iter().map(|e| format!("{:?}", e.kind)).collect();
                assert!(kinds.contains(&"Heard".to_string()));
                assert!(kinds.contains(&"Spoke".to_string()));
                assert_eq!(s.turn_count, 1);
                assert!(s.spoken_seconds() > 0.0);
            })
            .unwrap();
        let _ = registry().stop("brain-fallback");
    }

    #[test]
    fn extract_chat_completion_text_pulls_first_choice() {
        let raw = json!({
            "choices": [
                { "message": { "content": "  hello world  " } }
            ]
        });
        assert_eq!(
            extract_chat_completion_text(&raw),
            Some("hello world".to_string())
        );
    }

    #[test]
    fn extract_chat_completion_text_returns_none_on_malformed() {
        assert_eq!(extract_chat_completion_text(&json!({})), None);
        assert_eq!(
            extract_chat_completion_text(&json!({ "choices": [] })),
            None
        );
    }

    #[test]
    fn recent_dialog_history_maps_event_kinds_to_chat_roles() {
        let now = 0;
        let events = vec![
            SessionEvent {
                kind: SessionEventKind::Heard,
                text: "Alice: how's the build going".into(),
                timestamp_ms: now,
            },
            SessionEvent {
                kind: SessionEventKind::Note,
                text: "wake word".into(),
                timestamp_ms: now,
            },
            SessionEvent {
                kind: SessionEventKind::Spoke,
                text: "Build is green.".into(),
                timestamp_ms: now,
            },
            SessionEvent {
                kind: SessionEventKind::Heard,
                text: "Bob: ship it".into(),
                timestamp_ms: now,
            },
        ];
        let history = recent_dialog_history(&events, 10);
        assert_eq!(history.len(), 3, "Note events are dropped");
        assert_eq!(history[0].role, "user");
        assert_eq!(history[1].role, "assistant");
        assert_eq!(history[2].role, "user");
        assert_eq!(history[2].content, "Bob: ship it");
    }

    #[test]
    fn recent_dialog_history_caps_at_window_keeping_most_recent() {
        let events: Vec<SessionEvent> = (0..30)
            .map(|i| SessionEvent {
                kind: SessionEventKind::Heard,
                text: format!("line {i}"),
                timestamp_ms: 0,
            })
            .collect();
        let history = recent_dialog_history(&events, 5);
        assert_eq!(history.len(), 5);
        assert_eq!(history[0].content, "line 25");
        assert_eq!(history[4].content, "line 29");
    }

    #[test]
    fn strip_for_speech_removes_markdown_punctuation_and_fences() {
        let raw = "**Got it.** Adding `that` to your follow-ups.";
        assert_eq!(
            strip_for_speech(raw),
            "Got it. Adding that to your follow-ups."
        );
        let fenced = "Sure:\n```\ncode\n```\nDone.";
        assert_eq!(strip_for_speech(fenced), "Sure: Done.");
        let bullets = "- one\n- two";
        assert_eq!(strip_for_speech(bullets), "one two");
    }

    #[test]
    fn strip_for_speech_preserves_empty_when_input_empty() {
        assert_eq!(strip_for_speech(""), "");
        assert_eq!(strip_for_speech("   \n  "), "");
    }
}
