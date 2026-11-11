/*
 * RNN E League – Tecmo Super Bowl web player
 * Lightweight NES player built on jsnes (Apache-2.0).
 * Keyboard, gamepad and multi-touch controls; season-mode (SRAM) saves; one save-state slot.
 *
 * Config: set data-rom on <body> to the members-only URL of the league ROM.
 */
(function () {
  "use strict";

  var W = 256, H = 240;
  var BTN = jsnes.Controller;
  var $ = function (s) { return document.querySelector(s); };

  // Two ways to get the ROM:
  //  - data-api: the RNN league server. Uses the Locker Room sign-in token (localStorage "rnn-token").
  //  - data-rom: a plain URL behind your own login (cookie-based), for other hosts.
  var cfg = {
    api: (document.body.getAttribute("data-api") || "").replace(/\/$/, ""),
    signin: document.body.getAttribute("data-signin") || "../#locker",
    rom: document.body.getAttribute("data-rom") || "",
    title: document.body.getAttribute("data-title") || "Tecmo Super Bowl"
  };

  // ---------- screen ----------
  var canvas = $("#screen");
  var ctx = canvas.getContext("2d", { alpha: false });
  var img = ctx.createImageData(W, H);
  var buf32 = new Uint32Array(img.data.buffer);
  function onFrame(fb) {
    for (var i = 0; i < 61440; i++) buf32[i] = 0xff000000 | fb[i];
  }
  function draw() { ctx.putImageData(img, 0, 0); }

  // ---------- emulator ----------
  var speakers = null, timer = null, nes = null, lastCatchUp = 0;
  var romKey = null, running = false, paused = false, muted = false, started = false;

  function makeNes(sampleRate) {
    nes = new jsnes.NES({
      onFrame: onFrame,
      onAudioSample: function (l, r) { if (speakers && !muted) speakers.writeSample(l, r); },
      onBatteryRamWrite: function () { sramDirty = true; },
      sampleRate: sampleRate || 44100
    });
  }

  timer = new jsnes.FrameTimer({
    onGenerateFrame: function () {
      try {
        pollGamepads();
        nes.frame();
        if (speakers) speakers.flush();
      } catch (e) {
        stop();
        showOverlay("The game stopped unexpectedly.", "Restart", function () { resetGame(); start(); });
        console.error(e);
      }
    },
    onWriteFrame: draw
  });
  timer.stop();

  function start() {
    if (running) return;
    running = true; paused = false;
    timer.start();
    if (speakers && speakers.audioCtx && speakers.audioCtx.state === "suspended") speakers.audioCtx.resume();
    setPauseIcon();
  }
  function stop() {
    running = false;
    timer.stop();
    if (speakers && speakers.audioCtx && speakers.audioCtx.state === "running") speakers.audioCtx.suspend();
    setPauseIcon();
  }

  // ---------- storage (IndexedDB, fails soft) ----------
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      try {
        var r = indexedDB.open("rnn-tsb-player", 1);
        r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      } catch (e) { rej(e); }
    });
    return dbp;
  }
  function kvGet(k) {
    return db().then(function (d) {
      return new Promise(function (res) {
        var q = d.transaction("kv").objectStore("kv").get(k);
        q.onsuccess = function () { res(q.result); };
        q.onerror = function () { res(undefined); };
      });
    }).catch(function () { return undefined; });
  }
  function kvSet(k, v) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction("kv", "readwrite");
        t.objectStore("kv").put(v, k);
        t.oncomplete = function () { res(true); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }

  // ---------- season saves (battery SRAM $6000-$7FFF) ----------
  var sramDirty = false;
  function readSram() { return Uint8Array.from(nes.cpu.mem.slice(0x6000, 0x8000)); }
  function writeSram(a) { for (var i = 0; i < 0x2000; i++) nes.cpu.mem[0x6000 + i] = a[i]; }
  function flushSram() {
    if (!sramDirty || !romKey || !nes) return;
    sramDirty = false;
    kvSet(romKey + ":sram", readSram()).catch(function () {});
  }
  setInterval(flushSram, 3000);

  // ---------- ROM loading ----------
  function hash(bytes) { // FNV-1a, enough to key saves per ROM build
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i += 7) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16) + "-" + bytes.length;
  }

  function bootRom(bytes) {
    if (bytes[0] !== 0x4e || bytes[1] !== 0x45 || bytes[2] !== 0x53) throw new Error("That file isn't an NES ROM.");
    romKey = "rom-" + hash(bytes);
    makeNes(44100);
    nes.loadROM(bytes);
    return kvGet(romKey + ":sram").then(function (s) {
      if (s && s.length === 0x2000) writeSram(s);
      draw();
      showOverlay(null, isTouch ? "Tap to Play" : "Click to Play", firstStart);
    });
  }

  // The ROM is loaded before the audio device exists, so once we know the device's
  // real sample rate (44.1k or 48k), retune the APU so music plays at the right pitch.
  var deviceRate = 44100;
  function applyRate() {
    if (!nes || !nes.papu) return;
    nes.opts.sampleRate = deviceRate;
    nes.papu.sampleRate = deviceRate;
    nes.papu.setFrameRate(60);
  }

  function firstStart() {
    // Audio must be created inside a user gesture (iOS/Safari/Chrome autoplay rules).
    if (!speakers) {
      speakers = new jsnes.Speakers({
        // The audio worklet reports an underrun every ~3 ms while its buffer is short. Answer with at
        // most one catch-up frame per screen refresh, otherwise the game fast-forwards in bursts.
        onBufferUnderrun: function () {
          if (!running || document.hidden) return;
          var t = performance.now();
          if (t - lastCatchUp < 14) return;
          lastCatchUp = t;
          timer.generateFrame();
        }
      });
      try {
        var p = speakers.start();
        if (p && p.catch) p.catch(function () { speakers = null; });
        if (speakers.audioCtx) { deviceRate = speakers.audioCtx.sampleRate; applyRate(); }
      } catch (e) { speakers = null; }
    }
    started = true;
    hideOverlay();
    start();
  }

  function goSignIn() { location.href = cfg.signin; }
  function token() { try { return localStorage.getItem("rnn-token"); } catch (_) { return null; } }

  function loadFromUrl() {
    var url, opts;
    if (cfg.api) {
      var t = token();
      if (!t) { showOverlay("Sign in to the Locker Room to play.", "Go to the Locker Room", goSignIn, true); return; }
      url = cfg.api + "/api/tecmo/rom";
      opts = { headers: { authorization: "Bearer " + t }, cache: "no-store" };
    } else if (cfg.rom) {
      url = cfg.rom;
      opts = { credentials: "same-origin" };
    } else {
      showOverlay("No game is set up on this page.", "Choose ROM file…", function () { $("#file").click(); }, true);
      return;
    }
    showOverlay("Loading " + cfg.title + "…");
    fetch(url, opts)
      .then(function (r) {
        if (r.ok) return r.arrayBuffer();
        return r.json().catch(function () { return {}; }).then(function (d) {
          var e = new Error(d.error || ("Couldn't load the game (" + r.status + ")."));
          e.status = r.status; throw e;
        });
      })
      .then(function (ab) { return bootRom(new Uint8Array(ab)); })
      .catch(function (e) {
        if (e.status === 401) { showOverlay("Your sign-in expired. Sign in to the Locker Room to play.", "Go to the Locker Room", goSignIn, true); return; }
        if (cfg.api) { showOverlay(e.status ? e.message : "The league server can't be reached. Check your connection and try again.", e.status ? "Back to the Locker Room" : "Try again", e.status ? goSignIn : loadFromUrl, true); return; }
        showOverlay(e.message || "Couldn't load the game.", "Choose ROM file…", function () { $("#file").click(); }, true);
      });
  }

  $("#file").addEventListener("change", function () {
    var f = this.files && this.files[0];
    if (!f) return;
    f.arrayBuffer().then(function (ab) { return bootRom(new Uint8Array(ab)); })
      .catch(function (e) { showOverlay(e.message, "Choose ROM file…", function () { $("#file").click(); }, true); });
  });

  // ---------- overlay / toast ----------
  var overlay = $("#overlay"), overlayMsg = $("#overlay-msg"), overlayBtn = $("#overlay-btn");
  var overlayAction = null;
  function showOverlay(msg, btnLabel, action, isError) {
    overlay.hidden = false;
    overlay.classList.toggle("error", !!isError);
    overlayMsg.textContent = msg || "";
    overlayMsg.hidden = !msg;
    overlayBtn.hidden = !btnLabel;
    overlayBtn.textContent = btnLabel || "";
    overlayAction = action || null;
  }
  function hideOverlay() { overlay.hidden = true; }
  overlayBtn.addEventListener("click", function () { if (overlayAction) overlayAction(); });

  var toastT;
  function toast(t) {
    var el = $("#toast");
    el.textContent = t; el.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(function () { el.classList.remove("show"); }, 1600);
  }

  // ---------- input: shared press bookkeeping ----------
  // Each source (keyboard, touch, gamepad) reports its own set; a button is down if any source holds it.
  var held = { 1: {}, 2: {} };
  function press(p, b, src) {
    if (!nes) return;
    var s = held[p][b] || (held[p][b] = {});
    var was = Object.keys(s).length > 0;
    s[src] = true;
    if (!was) nes.buttonDown(p, b);
  }
  function release(p, b, src) {
    if (!nes) return;
    var s = held[p][b];
    if (!s || !s[src]) return;
    delete s[src];
    if (Object.keys(s).length === 0) nes.buttonUp(p, b);
  }
  function releaseAll() {
    [1, 2].forEach(function (p) {
      Object.keys(held[p]).forEach(function (b) {
        if (Object.keys(held[p][b]).length) { held[p][b] = {}; if (nes) nes.buttonUp(p, +b); }
      });
    });
  }

  // ---------- keyboard ----------
  var KEYS = {
    // Player 1
    ArrowUp: [1, BTN.BUTTON_UP], ArrowDown: [1, BTN.BUTTON_DOWN], ArrowLeft: [1, BTN.BUTTON_LEFT], ArrowRight: [1, BTN.BUTTON_RIGHT],
    KeyW: [1, BTN.BUTTON_UP], KeyS: [1, BTN.BUTTON_DOWN], KeyA: [1, BTN.BUTTON_LEFT], KeyD: [1, BTN.BUTTON_RIGHT],
    KeyX: [1, BTN.BUTTON_A], KeyZ: [1, BTN.BUTTON_B],
    Enter: [1, BTN.BUTTON_START], ShiftRight: [1, BTN.BUTTON_SELECT], ShiftLeft: [1, BTN.BUTTON_SELECT],
    // Player 2
    KeyI: [2, BTN.BUTTON_UP], KeyK: [2, BTN.BUTTON_DOWN], KeyJ: [2, BTN.BUTTON_LEFT], KeyL: [2, BTN.BUTTON_RIGHT],
    Period: [2, BTN.BUTTON_A], Comma: [2, BTN.BUTTON_B],
    BracketRight: [2, BTN.BUTTON_START], BracketLeft: [2, BTN.BUTTON_SELECT]
  };
  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.code === "KeyP" || e.code === "Escape") { if (started) togglePause(); e.preventDefault(); return; }
    if (e.code === "F2") { saveState(); e.preventDefault(); return; }
    if (e.code === "F4") { loadState(); e.preventDefault(); return; }
    var k = KEYS[e.code];
    if (!k) return;
    e.preventDefault();
    if (!started && !overlay.hidden && overlayAction === firstStart) { firstStart(); return; }
    press(k[0], k[1], "kb:" + e.code);
  });
  document.addEventListener("keyup", function (e) {
    var k = KEYS[e.code];
    if (k) { release(k[0], k[1], "kb:" + e.code); e.preventDefault(); }
  });
  window.addEventListener("blur", releaseAll);

  // ---------- gamepads (standard mapping) ----------
  var GP = [[0, BTN.BUTTON_B], [1, BTN.BUTTON_A], [2, BTN.BUTTON_B], [3, BTN.BUTTON_A],
            [8, BTN.BUTTON_SELECT], [9, BTN.BUTTON_START],
            [12, BTN.BUTTON_UP], [13, BTN.BUTTON_DOWN], [14, BTN.BUTTON_LEFT], [15, BTN.BUTTON_RIGHT]];
  var gpPrev = {};
  function pollGamepads() {
    if (!navigator.getGamepads) return;
    var pads = navigator.getGamepads(), n = 0;
    for (var i = 0; i < pads.length; i++) {
      var g = pads[i];
      if (!g || !g.connected) continue;
      var p = n++ === 0 ? 1 : 2;
      if (p > 2) break;
      var now = {};
      GP.forEach(function (m) { if (g.buttons[m[0]] && g.buttons[m[0]].pressed) now[m[1]] = 1; });
      var ax = g.axes[0] || 0, ay = g.axes[1] || 0;
      if (ax < -0.5) now[BTN.BUTTON_LEFT] = 1; if (ax > 0.5) now[BTN.BUTTON_RIGHT] = 1;
      if (ay < -0.5) now[BTN.BUTTON_UP] = 1; if (ay > 0.5) now[BTN.BUTTON_DOWN] = 1;
      var key = "gp" + g.index, prev = gpPrev[key] || {};
      for (var b in now) if (!prev[b]) press(p, +b, key);
      for (var b2 in prev) if (!now[b2]) release(p, +b2, key);
      gpPrev[key] = now;
    }
  }
  window.addEventListener("gamepadconnected", function (e) {
    toast("Controller connected");
    if (isTouch && !padForced) setPadVisible(false);
  });

  // ---------- touch controls ----------
  var isTouch = ("ontouchstart" in window) || (navigator.maxTouchPoints > 0) ||
                (window.matchMedia && matchMedia("(pointer: coarse)").matches);
  var pad = $("#pad"), padForced = false;
  function setPadVisible(v) {
    document.body.classList.toggle("touch", v);
    $("#btn-pad").setAttribute("aria-pressed", v ? "true" : "false");
    if (typeof layout === "function") layout();
  }
  // Size the game screen and the touch controls to the space available.
  // Portrait: pad sits below the game. Landscape: pad sits in the side columns, and the
  // game shrinks a little if the sides are too narrow for thumbs (e.g. iPad landscape).
  var stage = $("#stage");
  function layout() {
    var vw = window.innerWidth, vh = window.innerHeight;
    var touchOn = document.body.classList.contains("touch");
    var land = vw > vh;
    var ctrl = 0;
    if (touchOn) {
      ctrl = land ? 0 : Math.round(Math.max(120, Math.min(vw * 0.42, 200, vh * 0.26)));
      pad.style.setProperty("--ctrl", ctrl + "px");
    }
    var r = stage.getBoundingClientRect();
    var aw = r.width, ah = r.height;
    if (touchOn && land) {
      var gw0 = Math.min(aw, ah * W / H);
      var side = (aw - gw0) / 2;
      ctrl = Math.round(Math.max(ah > 600 ? 160 : 120, Math.min(side - 24, 190, ah - 60)));
      pad.style.setProperty("--ctrl", ctrl + "px");
      aw = Math.max(160, aw - 2 * (ctrl + 24));
    }
    var scale = Math.min(aw / W, ah / H);
    canvas.style.width = Math.floor(W * scale) + "px";
    canvas.style.height = Math.floor(H * scale) + "px";
  }
  window.addEventListener("resize", layout);
  window.addEventListener("orientationchange", function () { setTimeout(layout, 250); });

  setPadVisible(isTouch);
  $("#btn-pad").addEventListener("click", function () {
    padForced = true; setPadVisible(!document.body.classList.contains("touch"));
  });

  var DIRS = { u: BTN.BUTTON_UP, d: BTN.BUTTON_DOWN, l: BTN.BUTTON_LEFT, r: BTN.BUTTON_RIGHT };
  var NAMED = { a: BTN.BUTTON_A, b: BTN.BUTTON_B, start: BTN.BUTTON_START, select: BTN.BUTTON_SELECT };
  var touchPrev = {};

  function buttonsAt(x, y) {
    var el = document.elementFromPoint(x, y);
    var out = [];
    if (!el) return out;
    var zone = el.closest("[data-btn],[data-dpad]");
    if (!zone) return out;
    if (zone.hasAttribute("data-dpad")) {
      var r = zone.getBoundingClientRect();
      var dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
      var dead = r.width * 0.12;
      if (Math.abs(dx) < dead && Math.abs(dy) < dead) return out;
      var ang = Math.atan2(dy, dx) * 180 / Math.PI; // 8-way, 45° sectors
      if (ang > -157.5 && ang < -22.5) out.push(DIRS.u);
      if (ang > 22.5 && ang < 157.5) out.push(DIRS.d);
      if (ang > 112.5 || ang < -112.5) out.push(DIRS.l);
      if (ang > -67.5 && ang < 67.5) out.push(DIRS.r);
    } else {
      var n = zone.getAttribute("data-btn");
      if (n === "ab") { out.push(NAMED.a, NAMED.b); } else if (NAMED[n] != null) out.push(NAMED[n]);
    }
    return out;
  }

  function handleTouches(e) {
    e.preventDefault();
    if (!started && overlayAction === firstStart) { firstStart(); }
    var now = {};
    for (var i = 0; i < e.touches.length; i++) {
      var t = e.touches[i];
      buttonsAt(t.clientX, t.clientY).forEach(function (b) { now[b] = 1; });
    }
    var fresh = false;
    for (var b in now) if (!touchPrev[b]) { press(1, +b, "touch"); fresh = true; }
    for (var b2 in touchPrev) if (!now[b2]) release(1, +b2, "touch");
    touchPrev = now;
    if (fresh && navigator.vibrate) { try { navigator.vibrate(8); } catch (_) {} }
    // visual feedback
    pad.querySelectorAll(".on").forEach(function (el) { el.classList.remove("on"); });
    for (var k in now) {
      var sel = { 0: '[data-btn="a"]', 1: '[data-btn="b"]', 2: '[data-btn="select"]', 3: '[data-btn="start"]',
                  4: ".dp-u", 5: ".dp-d", 6: ".dp-l", 7: ".dp-r" }[k];
      var el = sel && pad.querySelector(sel); if (el) el.classList.add("on");
    }
  }
  ["touchstart", "touchmove", "touchend", "touchcancel"].forEach(function (t) {
    pad.addEventListener(t, handleTouches, { passive: false });
  });
  // Mouse fallback so the on-screen pad also works with a mouse/trackpad.
  var mouseDown = false;
  function mouseFake(e, down) {
    var fakeTouches = down ? [{ clientX: e.clientX, clientY: e.clientY }] : [];
    handleTouches({ preventDefault: function () { e.preventDefault(); }, touches: fakeTouches });
  }
  pad.addEventListener("mousedown", function (e) { mouseDown = true; mouseFake(e, true); });
  window.addEventListener("mousemove", function (e) { if (mouseDown) mouseFake(e, true); });
  window.addEventListener("mouseup", function (e) { if (mouseDown) { mouseDown = false; mouseFake(e, false); } });

  // Stop iOS double-tap zoom / pinch on the game area.
  document.addEventListener("gesturestart", function (e) { e.preventDefault(); });
  $("#stage").addEventListener("touchstart", function (e) {
    if (!started && overlayAction === firstStart && e.target.closest("#overlay")) return;
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  // ---------- menu actions ----------
  function setPauseIcon() {
    var b = $("#btn-pause");
    b.setAttribute("aria-label", running ? "Pause" : "Resume");
    b.innerHTML = running ? ICON.pause : ICON.play;
  }
  function togglePause() {
    if (!started) return;
    if (running) { paused = true; stop(); releaseAll(); showOverlay("Paused", "Resume", function () { hideOverlay(); start(); }); }
    else { hideOverlay(); start(); }
  }
  function resetGame() {
    if (!nes) return;
    var s = readSram();
    nes.reloadROM();
    applyRate();
    writeSram(s);
    releaseAll();
  }
  function saveState() {
    if (!nes || !started) return;
    try {
      var st = nes.toJSON();
      kvSet(romKey + ":state1", JSON.stringify(st)).then(function () { toast("State saved"); })
        .catch(function () { toast("Couldn't save state"); });
    } catch (e) { toast("Couldn't save state"); }
  }
  function loadState() {
    if (!nes || !started) return;
    kvGet(romKey + ":state1").then(function (s) {
      if (!s) { toast("No saved state yet"); return; }
      try { nes.fromJSON(JSON.parse(s)); applyRate(); releaseAll(); toast("State loaded"); draw(); }
      catch (e) { toast("Couldn't load state"); }
    });
  }

  $("#btn-pause").addEventListener("click", togglePause);
  $("#btn-reset").addEventListener("click", function () {
    if (!started) return;
    if (confirm("Reset the game? Season progress already saved in the game is kept.")) { resetGame(); toast("Reset"); }
  });
  $("#btn-save").addEventListener("click", saveState);
  $("#btn-load").addEventListener("click", loadState);
  $("#btn-mute").addEventListener("click", function () {
    muted = !muted;
    this.innerHTML = muted ? ICON.muted : ICON.sound;
    this.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  });
  var fsTarget = document.documentElement;
  var canFs = !!(fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen);
  $("#btn-fs").hidden = !canFs;
  $("#btn-fs").addEventListener("click", function () {
    var d = document;
    if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    else (fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen).call(fsTarget);
  });
  $("#btn-help").addEventListener("click", function () { $("#help").showModal ? $("#help").showModal() : ($("#help").open = true); });
  $("#help-close").addEventListener("click", function () { $("#help").close(); });

  // Auto-pause when the tab is hidden or the phone locks; save season data.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { flushSram(); if (running) { stop(); releaseAll(); showOverlay("Paused", "Resume", function () { hideOverlay(); start(); }); } }
  });
  window.addEventListener("pagehide", flushSram);

  var ICON = {
    pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 5v14l12-7z"/></svg>',
    sound: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    muted: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  };
  setPauseIcon();
  $("#btn-mute").innerHTML = ICON.sound;
  document.title = cfg.title;
  $("#title").textContent = cfg.title;

  // Expose a tiny hook for testing/debugging.
  window.TSBPlayer = { get nes() { return nes; }, press: press, release: release, start: start, stop: stop };

  loadFromUrl();
})();
