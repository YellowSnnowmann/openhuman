// OpenHuman audio bridge for the embedded Google Meet webview.
//
// Installed via CDP `Page.addScriptToEvaluateOnNewDocument` from the
// Tauri shell (`app/src-tauri/src/meet_audio/inject.rs`) so it runs at
// document-start, *before* Meet's join page calls
// `navigator.mediaDevices.getUserMedia`. The shell then triggers a
// `Page.reload` so that even an already-navigated meet page picks up
// the override.
//
// What this script does:
//
// 1. Builds a 16 kHz mono Web-Audio graph whose
//    `MediaStreamAudioDestinationNode` provides an audio MediaStream
//    track the page can hand to its RTCPeerConnection.
// 2. Monkey-patches `navigator.mediaDevices.getUserMedia` so any audio
//    request returns our destination stream (and combined audio+video
//    requests get the real video track from Chromium's fake-camera Y4M
//    plus our audio track).
// 3. Exposes `window.__openhumanFeedPcm(b64)` — the Tauri shell calls
//    this on a ~100 ms cadence via CDP `Runtime.evaluate` to push the
//    next chunk of synthesized PCM16LE bytes from
//    `openhuman.meet_agent_poll_speech`.
//
// JS-injection note: the project's broader rule (CLAUDE.md) is "no new
// JS in embedded provider webviews". The Meet call window is a special
// case — it is a dedicated top-level window for a single audio-bridging
// purpose where the public `CefAudioHandler` API is sufficient for the
// listen path but Chromium's audio *input* path has no comparable
// public hook short of a from-source rebuild. The user has explicitly
// authorized this injection for the speak path; legacy provider
// webviews keep the no-JS rule.

(function () {
  if (window.__openhumanAudioBridgeInstalled) {
    console.log("[openhuman-audio-bridge] already installed; skipping");
    return;
  }
  window.__openhumanAudioBridgeInstalled = true;
  console.log("[openhuman-audio-bridge] install begin");

  var SAMPLE_RATE = 16000;
  var ctx;
  var dest;
  var nextStartTime = 0;

  function ensureContext() {
    if (ctx) {
      // Resume if suspended (CEF suspends until user gesture; the
      // meet_scanner's synthetic clicks count as gestures on some
      // builds but not all).
      if (ctx.state === "suspended") {
        ctx.resume().catch(function () {});
        console.log("[openhuman-audio-bridge] resumed suspended AudioContext");
      }
      return ctx;
    }
    var requestedRate = SAMPLE_RATE;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: SAMPLE_RATE,
      });
    } catch (e) {
      // Some Chromium builds don't honor the explicit sampleRate; fall
      // back to the default (the bridge will resample implicitly via
      // each AudioBuffer's declared rate).
      console.warn(
        "[openhuman-audio-bridge] AudioContext sampleRate hint rejected; falling back to default rate err=" +
          e
      );
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    dest = ctx.createMediaStreamDestination();
    nextStartTime = ctx.currentTime;
    console.log(
      "[openhuman-audio-bridge] AudioContext created requested_rate=" +
        requestedRate +
        " actual_rate=" +
        ctx.sampleRate +
        " state=" +
        ctx.state
    );
    return ctx;
  }

  function decodeBase64Pcm16leToFloat32(b64) {
    var bin = atob(b64);
    var len = bin.length;
    if (len % 2 !== 0) {
      // Trailing byte = corrupt frame; drop it rather than read past
      // the end and emit a click.
      len = len - 1;
    }
    var out = new Float32Array(len / 2);
    for (var i = 0, j = 0; j < len; i++, j += 2) {
      var lo = bin.charCodeAt(j);
      var hi = bin.charCodeAt(j + 1);
      var v = (hi << 8) | lo;
      if (v & 0x8000) v -= 0x10000;
      out[i] = v / 32768;
    }
    return out;
  }

  // Track every scheduled AudioBufferSource so __openhumanFlushAudio
  // can stop them on barge-in (user re-asks during a long bot reply).
  // Without this list, only the queue tail past `nextStartTime` would
  // be cancellable; anything already start()-ed plays to completion.
  var activeSources = [];

  // Stop in-flight playback and reset the schedule cursor. Called by
  // the Rust shell when the brain cancels outbound (new wake fires
  // mid-reply). Returns the number of sources that were stopped, so
  // the shell can log how much speech got cut.
  window.__openhumanFlushAudio = function () {
    var stopped = 0;
    while (activeSources.length) {
      var s = activeSources.pop();
      try { s.stop(); stopped++; } catch (_) {}
      try { s.disconnect(); } catch (_) {}
    }
    if (ctx) {
      nextStartTime = ctx.currentTime;
    }
    return stopped;
  };

  // Public push API. Returns the duration in seconds the chunk added
  // to the queue, mostly for diagnostics; the shell ignores it.
  window.__openhumanFeedPcm = function (b64) {
    if (!b64) return 0;
    try {
      ensureContext();
      var samples = decodeBase64Pcm16leToFloat32(b64);
      if (!samples.length) return 0;
      var buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
      buffer.copyToChannel(samples, 0, 0);
      var src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(dest);
      // Also pipe to the page's default audio output so the bot's
      // TTS is audible on the host machine. This does NOT cause echo
      // because Meet attributes the bot's own speech to "You" (which
      // is filtered in core's note_caption) and the media-element
      // mute below silences Meet's INCOMING call audio (other
      // participants' voices bouncing back through speakers).
      src.connect(ctx.destination);
      // Schedule strictly after the previous chunk so successive
      // 100 ms feeds line up gaplessly. If the queue has emptied
      // (caller fell behind), restart at currentTime so we don't try
      // to play in the past.
      if (nextStartTime < ctx.currentTime) {
        nextStartTime = ctx.currentTime;
      }
      src.start(nextStartTime);
      activeSources.push(src);
      src.onended = function () {
        var idx = activeSources.indexOf(src);
        if (idx !== -1) activeSources.splice(idx, 1);
      };
      nextStartTime += buffer.duration;
      // High-frequency log gated by a counter so we don't drown the
      // console at 10 Hz; emit ~1 in 50 frames (~5 s cadence at the
      // shell's 100 ms feed rate).
      window.__openhumanFeedCounter = (window.__openhumanFeedCounter || 0) + 1;
      if (window.__openhumanFeedCounter % 50 === 1) {
        console.log(
          "[openhuman-audio-bridge] feed sampled chunk_dur=" +
            buffer.duration.toFixed(3) +
            "s queue_ahead=" +
            (nextStartTime - ctx.currentTime).toFixed(3) +
            "s frame=" +
            window.__openhumanFeedCounter
        );
      }
      return buffer.duration;
    } catch (e) {
      console.warn("[openhuman-audio-bridge] feed failed:", e);
      return 0;
    }
  };

  // Public introspection — useful from the shell side via
  // Runtime.evaluate to confirm the bridge is alive.
  window.__openhumanAudioBridgeInfo = function () {
    return {
      installed: true,
      sample_rate: SAMPLE_RATE,
      audio_context_state: ctx ? ctx.state : "not-created",
      next_start_time: nextStartTime,
      destination_track_count: dest ? dest.stream.getAudioTracks().length : 0,
    };
  };

  // Override getUserMedia so Meet's audio requests are served from our
  // bridge stream. We delegate video to the original implementation so
  // Chromium's fake-camera Y4M (mascot) keeps working.
  if (
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== "function"
  ) {
    console.warn(
      "[openhuman-audio-bridge] navigator.mediaDevices.getUserMedia missing; interception disabled"
    );
    return;
  }
  var origGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  // Build a fresh audio MediaStream backed by clones of the bridge's
  // destination tracks. Returning the singleton `dest.stream` directly
  // would let any caller's `track.stop()` (e.g. Meet during preview
  // teardown / track renegotiation) permanently kill the bridge. Each
  // call gets its own track lifecycle.
  function freshAudioStream() {
    ensureContext();
    return new MediaStream(
      dest.stream.getAudioTracks().map(function (t) {
        return t.clone();
      })
    );
  }

  navigator.mediaDevices.getUserMedia = function (constraints) {
    if (!constraints || !constraints.audio) {
      console.log(
        "[openhuman-audio-bridge] getUserMedia passthrough (no audio)"
      );
      return origGum(constraints);
    }

    if (!constraints.video) {
      console.log(
        "[openhuman-audio-bridge] getUserMedia intercepted audio-only"
      );
      return Promise.resolve(freshAudioStream());
    }
    // Combined audio + video request: pull video from the real
    // (fake-camera-backed) getUserMedia and splice in fresh clones of
    // our audio tracks.
    console.log(
      "[openhuman-audio-bridge] getUserMedia intercepted audio+video; splicing audio onto fake-camera stream"
    );
    return origGum({ video: constraints.video }).then(function (realStream) {
      try {
        realStream.getAudioTracks().forEach(function (t) {
          realStream.removeTrack(t);
          t.stop();
        });
      } catch (_) {}
      freshAudioStream()
        .getAudioTracks()
        .forEach(function (t) {
          realStream.addTrack(t);
        });
      return realStream;
    });
  };

  // Best-effort: also patch the legacy `getUserMedia` aliases some
  // older Meet code paths still call into.
  if (typeof navigator.getUserMedia === "function") {
    console.log("[openhuman-audio-bridge] patching legacy navigator.getUserMedia");
    var origLegacy = navigator.getUserMedia.bind(navigator);
    navigator.getUserMedia = function (constraints, success, failure) {
      navigator.mediaDevices
        .getUserMedia(constraints)
        .then(success, failure)
        .catch(function (e) {
          if (failure) failure(e);
          else origLegacy(constraints, success, failure);
        });
    };
  }
  // Mute all inbound call audio on this page. The bot's CEF window is
  // a headless participant — it reads captions for input and uses the
  // virtual mic for output. Any audio that plays through the local
  // speakers gets picked up by the user's mic (they're on the same
  // machine) and causes an echo loop. We:
  //
  //   1. Mute all existing <audio> and <video> elements.
  //   2. Observe the DOM for new media elements and mute those too.
  //   3. Monkey-patch HTMLMediaElement.prototype.play to auto-mute
  //      before playing, catching dynamically created elements that
  //      aren't in the DOM yet.
  //
  // This does NOT affect the bridge's outbound TTS path — that goes
  // through the Web Audio graph's MediaStreamDestination (virtual mic),
  // not through any <audio>/<video> element.
  function muteMediaElement(el) {
    try {
      el.muted = true;
      el.volume = 0;
    } catch (_) {}
  }

  function muteAllMedia() {
    var els = document.querySelectorAll("audio, video");
    for (var i = 0; i < els.length; i++) {
      muteMediaElement(els[i]);
    }
  }

  // Initial sweep (may be empty at document-start; the observer
  // and play-patch handle late arrivals).
  muteAllMedia();

  // Observe DOM for dynamically added media elements.
  try {
    var mediaObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          if (node.tagName === "AUDIO" || node.tagName === "VIDEO") {
            muteMediaElement(node);
          }
          // Also check children (e.g. a div containing a <video>).
          if (node.querySelectorAll) {
            var inner = node.querySelectorAll("audio, video");
            for (var k = 0; k < inner.length; k++) {
              muteMediaElement(inner[k]);
            }
          }
        }
      }
    });
    mediaObserver.observe(document.documentElement || document.body || document, {
      childList: true,
      subtree: true,
    });
  } catch (e) {
    console.warn("[openhuman-audio-bridge] media mute observer failed:", e);
  }

  // Monkey-patch play() to ensure mute sticks even for elements created
  // outside the DOM (Meet sometimes uses detached <audio> for WebRTC).
  try {
    var origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      muteMediaElement(this);
      return origPlay.apply(this, arguments);
    };
  } catch (e) {
    console.warn("[openhuman-audio-bridge] play() patch failed:", e);
  }

  console.log("[openhuman-audio-bridge] install complete (local audio muted)");
})();
