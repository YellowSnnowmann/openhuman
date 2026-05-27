// OpenHuman captions bridge for the embedded Google Meet webview.
//
// Companion to `audio_bridge.js`. Where the audio bridge handles the
// SPEAK direction (synthesized PCM → MediaStream the page hands to its
// RTCPeerConnection), this script handles the LISTEN direction by
// scraping Meet's built-in live captions instead of running our own
// STT pipeline:
//
//   - Auto-click the "Turn on captions" button so the user doesn't
//     have to remember.
//   - Watch the captions region with a MutationObserver and a 250 ms
//     poll fallback (Meet sometimes batches DOM updates outside the
//     observer's notify window).
//   - Maintain a queue of new caption lines, deduped by speaker+text.
//     Each entry: { speaker, text, ts }.
//   - Expose `window.__openhumanDrainCaptions()` and
//     `__openhumanCaptionsBridgeInfo()` for the Tauri shell to drive
//     over CDP `Runtime.evaluate`.
//
// Why scraping (and not getDisplayMedia, or Web Speech, or Meet's
// undocumented APIs)?
//   - getDisplayMedia would prompt the user for screen-share permission.
//   - Web Speech doesn't reach the remote participants' audio — only
//     local mic.
//   - Meet has no public caption API.
//   - The captions DOM is the simplest stable source. Class names
//     obfuscate often, so we lean on `aria-label="Captions"` (which
//     Meet keeps stable for accessibility).
//
// Wake-word handling lives in the core (`src/openhuman/meet_agent/`),
// not here — the page just streams every caption line out and core
// decides when to act.

(function () {
  if (window.__openhumanCaptionsBridgeInstalled) {
    return;
  }
  window.__openhumanCaptionsBridgeInstalled = true;

  var queue = [];
  // Set of ALL caption texts we've already queued, keyed by
  // "speaker\t<normalized_text>". Meet keeps multiple caption rows
  // visible per speaker (a running transcript), and a single-slot
  // lastBySpeaker would flip-flop between rows on successive polls,
  // re-emitting old rows as "new". A seen-set prevents any text
  // (or prefix-growth of that text) from being emitted twice.
  var seenTexts = {};
  // Per-speaker last-text for delta extraction: when a caption row
  // grows in place ("Hey openhuman" → "Hey openhuman what time"),
  // we only emit the new tail, not the full text containing the
  // already-processed wake phrase.
  var lastBySpeaker = {};

  function findCaptionsRegion() {
    // Meet's captions region carries a stable accessibility label
    // even as class names churn between rollouts. Try several
    // strategies — Meet keeps changing the exact DOM shape.
    return (
      // Canonical English aria-label
      document.querySelector('[aria-label="Captions"]') ||
      // Fuzzy match for localized builds
      document.querySelector('div[role="region"][aria-label*="aption" i]') ||
      // Meet 2024+: the captions container sometimes uses role="log"
      // with an aria-label containing "caption" or "subtitle"
      document.querySelector('[role="log"][aria-label*="aption" i]') ||
      document.querySelector('[role="log"][aria-label*="ubtitle" i]') ||
      // Last resort: any element whose aria-label contains "caption"
      document.querySelector('[aria-label*="aption" i][aria-live]') ||
      null
    );
  }

  function pollOnce() {
    var region = findCaptionsRegion();
    if (!region) return;

    // Each caption line is typically a flex row with the speaker name
    // at the top and the live transcript below. We don't depend on
    // exact class names; instead we walk direct children and treat
    // each as one caption "row". Meet sometimes nests rows inside an
    // intermediate wrapper div, so also look one level deeper.
    var rows = region.querySelectorAll(
      ':scope > div, :scope > section, :scope > [role="listitem"], ' +
      ':scope > div > div, :scope > [role="list"] > [role="listitem"]'
    );
    if (!rows.length) {
      // Fall back to a single-block region: one big innerText blob.
      var blob = (region.innerText || "").trim();
      var prevBlob = lastBySpeaker.__blob__ || "";
      if (blob && blob !== prevBlob) {
        var blobDelta = blob;
        if (prevBlob && blob.indexOf(prevBlob) === 0) {
          blobDelta = blob.slice(prevBlob.length).trim();
        }
        lastBySpeaker.__blob__ = blob;
        if (blobDelta) {
          queue.push({ speaker: "", text: blobDelta, ts: Date.now() });
        }
      }
      return;
    }

    rows.forEach(function (row) {
      // The speaker name is usually the first text child; the
      // transcript is the larger one beneath. Heuristic: the line
      // with the most text wins as "transcript".
      var nodes = row.querySelectorAll("*");
      var bestText = "";
      var bestCandidate = null;
      var speakerGuess = "";
      nodes.forEach(function (n) {
        var t = (n.innerText || "").trim();
        if (!t) return;
        if (!speakerGuess && t.length < 40 && /^[A-Za-z][\w '\-\.]*$/.test(t)) {
          speakerGuess = t;
        }
        if (t.length > bestText.length) {
          bestText = t;
          bestCandidate = n;
        }
      });
      if (!bestText) return;
      // Strip the speaker name out of the body if it's the leading
      // chunk (Meet sometimes renders "Alice  the meeting starts at 3"
      // as one innerText blob).
      if (speakerGuess && bestText.startsWith(speakerGuess)) {
        bestText = bestText.slice(speakerGuess.length).trim();
      }
      if (!bestText) return;

      var key = speakerGuess || "_unknown";
      // Fingerprint: lowercase so "Hey Openhuman" and "hey openhuman"
      // don't slip through as distinct entries.
      var fp = key + "\t" + bestText.toLowerCase();
      if (seenTexts[fp]) return;
      seenTexts[fp] = true;
      // Delta extraction: if this row is a prefix-growth of the last
      // text we saw for this speaker, only emit the new tail.
      var prev = lastBySpeaker[key] || "";
      lastBySpeaker[key] = bestText;
      var textToEmit = bestText;
      if (prev && bestText.indexOf(prev) === 0) {
        textToEmit = bestText.slice(prev.length).trim();
      }
      if (!textToEmit) return;
      queue.push({ speaker: speakerGuess, text: textToEmit, ts: Date.now() });
    });
  }

  // Two layers, because Meet sometimes batches caption DOM updates
  // in ways that miss MutationObserver notifications:
  //
  //   1. MutationObserver — fires immediately on DOM mutation, picks
  //      up character-data changes that the poll might miss between
  //      ticks.
  //   2. 250 ms interval poll — safety net for batched updates and
  //      for the case where the captions region didn't exist at
  //      observer-attach time.
  function attachObserver() {
    var region = findCaptionsRegion();
    if (!region || region.__openhumanObserverAttached) return false;
    region.__openhumanObserverAttached = true;
    var obs = new MutationObserver(function () {
      pollOnce();
    });
    obs.observe(region, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return true;
  }

  // Auto-enable captions. Strategy:
  //
  //   1. Try clicking a button whose aria-label matches known patterns
  //      (covers older Meet builds + localized labels).
  //   2. If no button found after a few tries, fall back to dispatching
  //      the keyboard shortcut "c" which toggles captions in Meet
  //      regardless of UI changes.
  //   3. Once the captions region appears, stop trying.
  //
  // Caps attempts so a user who deliberately disables CC isn't fought
  // over forever.
  var ENABLE_ATTEMPT_BUDGET = 60; // ~60 * 2s = 120s — covers slow admit
  var enableAttempts = 0;
  // After this many failed button-click attempts, switch to keyboard shortcut.
  var KEYBOARD_FALLBACK_AFTER = 8;
  var captionsEnabledConfirmed = false;

  function tryEnableCaptions() {
    if (captionsEnabledConfirmed || enableAttempts >= ENABLE_ATTEMPT_BUDGET) return;
    enableAttempts++;

    // If the captions region already exists, we're done.
    if (findCaptionsRegion()) {
      captionsEnabledConfirmed = true;
      enableAttempts = ENABLE_ATTEMPT_BUDGET;
      return true;
    }

    // Strategy 1: button click (works on older Meet builds)
    if (enableAttempts <= KEYBOARD_FALLBACK_AFTER) {
      var buttons = document.querySelectorAll("button[aria-label]");
      var ON_PATTERNS = [
        "turn on captions",
        "turn on live captions",
        "turn on subtitles",
        "turn on closed captions",
        "captions on",
        "captions (c)",
        "show captions",
        "enable captions",
      ];
      var OFF_PATTERNS = [
        "turn off captions",
        "turn off live captions",
        "turn off subtitles",
        "captions off",
        "disable captions",
        "hide captions",
        "hide subtitles",
      ];
      for (var i = 0; i < buttons.length; i++) {
        var lbl = (buttons[i].getAttribute("aria-label") || "").toLowerCase();
        if (OFF_PATTERNS.some(function (p) { return lbl.indexOf(p) >= 0; })) continue;
        var pressed = buttons[i].getAttribute("aria-pressed");
        if (pressed === "true") {
          captionsEnabledConfirmed = true;
          enableAttempts = ENABLE_ATTEMPT_BUDGET;
          return true;
        }
        if (ON_PATTERNS.some(function (p) { return lbl.indexOf(p) >= 0; })) {
          try { buttons[i].click(); captionsEnabledConfirmed = true; enableAttempts = ENABLE_ATTEMPT_BUDGET; return true; } catch (_) {}
        }
        // Bare label fallback
        if ((lbl === "captions" || lbl === "subtitles" || lbl === "cc") && pressed !== "true") {
          try { buttons[i].click(); captionsEnabledConfirmed = true; enableAttempts = ENABLE_ATTEMPT_BUDGET; return true; } catch (_) {}
        }
      }
    }

    // Strategy 2: keyboard shortcut "c" — Meet toggles captions on
    // key press regardless of button labels. We also try "j" (some
    // locales bind subtitles to "j"). We must check the region isn't
    // already visible first to avoid toggling OFF. Only fire the
    // shortcut every other attempt to give the DOM time to react.
    if (enableAttempts > KEYBOARD_FALLBACK_AFTER && enableAttempts % 2 === 0) {
      if (!findCaptionsRegion()) {
        try {
          // Dispatch a real "c" keypress to the document body so Meet
          // picks it up as its keyboard shortcut.
          var keyOpts = { key: "c", code: "KeyC", keyCode: 67, which: 67, bubbles: true };
          document.body.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
          document.body.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
        } catch (_) {}
      }
    }

    return false;
  }

  setInterval(function () {
    attachObserver();
    pollOnce();
    trimSeenTexts();
    // Quick check: confirm captions region appeared after a shortcut press
    if (!captionsEnabledConfirmed && findCaptionsRegion()) {
      captionsEnabledConfirmed = true;
      enableAttempts = ENABLE_ATTEMPT_BUDGET;
    }
  }, 250);
  setInterval(tryEnableCaptions, 2000);

  // Public API consumed by the Tauri shell over CDP Runtime.evaluate.
  window.__openhumanDrainCaptions = function () {
    var out = queue.slice();
    queue.length = 0;
    return out;
  };

  // Cap the seen-set so a multi-hour call doesn't leak memory.
  // 500 entries ≈ a very active 30-minute meeting; beyond that,
  // ancient captions have scrolled off Meet's visible region anyway.
  var MAX_SEEN = 500;
  function trimSeenTexts() {
    var keys = Object.keys(seenTexts);
    if (keys.length > MAX_SEEN) {
      // Drop the oldest half (insertion-order is preserved in V8).
      var toDrop = keys.slice(0, Math.floor(keys.length / 2));
      for (var i = 0; i < toDrop.length; i++) {
        delete seenTexts[toDrop[i]];
      }
    }
  }

  window.__openhumanCaptionsBridgeInfo = function () {
    var region = findCaptionsRegion();
    // Scan for caption-related buttons to help diagnose enable failures.
    var captionButtons = [];
    try {
      var buttons = document.querySelectorAll("button[aria-label]");
      for (var i = 0; i < buttons.length; i++) {
        var lbl = (buttons[i].getAttribute("aria-label") || "").toLowerCase();
        if (lbl.indexOf("caption") >= 0 || lbl.indexOf("subtitle") >= 0 || lbl === "cc") {
          captionButtons.push({
            label: lbl,
            pressed: buttons[i].getAttribute("aria-pressed"),
          });
        }
      }
    } catch (_) {}
    return {
      installed: true,
      region_found: !!region,
      region_tag: region ? region.tagName : null,
      region_aria: region ? region.getAttribute("aria-label") : null,
      region_children: region ? region.children.length : 0,
      queue_depth: queue.length,
      tracked_speakers: Object.keys(lastBySpeaker).length,
      seen_texts: Object.keys(seenTexts).length,
      enable_attempts: enableAttempts,
      enable_budget: ENABLE_ATTEMPT_BUDGET,
      caption_buttons: captionButtons,
    };
  };
})();
