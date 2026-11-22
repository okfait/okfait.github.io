// okMUSIC Phone Remote: the PC plays the music, the phone shows the same visuals live and
// has play / pause / skip / back / repeat (no stop, no timeline editor, no volume).
//
// PC: ••• → Phone remote → a QR code shows up. Phone: scan it (or open okMUSIC → ••• →
// Phone remote → type the code). Nothing to install, it's just the website.
//
// The PC sends the sound "levels" ~30 times a second (tiny, about 10KB/s) and the phone's
// own visualizer draws them, so it looks exactly like the PC: ring / bars / liquid V1 / V2,
// beat flash, colors, album art, lyrics.

import { host, join, cleanCode, qrSvg, shareLink } from "./link.js?v=2.21.0";

const $ = (id) => document.getElementById(id);
const toast = (m) => window.ui && window.ui.showToast(m);
const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const P = window.player;
const AS = window.audioSys;
const BINS = 384; // the visuals only use the low part of the spectrum

const R = {
  role: null, // "pc" | "phone"
  room: null,
  code: "",
  busy: false,
  // phone
  now: null,
  bins: new Uint8Array(1024),
  lastFrameAt: 0,
  wake: null,
  sendTimer: 0,
};

// ================================================================== PC side
function nowMsg() {
  const a = AS.audio;
  const s = P.currentTrack;
  return {
    t: "now",
    id: s ? s.id : null,
    name: s ? s.name : "",
    playing: !!(s && !a.paused && !a.ended),
    pos: a.currentTime || 0,
    at: performance.now(),
    rate: a.playbackRate || 1,
    dur: isFinite(a.duration) ? a.duration : 0,
    loop: !!P.loop,
    accent: (document.documentElement.style.getPropertyValue("--accent") || "").trim(),
    glow: (document.documentElement.style.getPropertyValue("--accent-glow") || "").trim(),
    hue: (document.documentElement.style.getPropertyValue("--bg-hue") || "").trim(),
    theme: window.ui ? window.ui.themeMode : "solid",
    mode: window.viz ? window.viz.mode : "ring",
    v2: !!(window.liquidV2 && window.liquidV2.active()),
    flash: window.viz ? window.viz.flash : true,
    ripple: window.viz ? window.viz.rippleEffect : true,
  };
}
let queued = false;
function pcSend() {
  if (R.role !== "pc" || queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    if (!R.room || !R.room.links.size) return;
    const m = nowMsg();
    const s = P.currentTrack;
    for (const L of R.room.links) {
      L.send(m);
      if (s && L.sentFor !== s.id) {
        L.sentFor = s.id;
        L.send({
          t: "song",
          id: s.id,
          art: typeof s.art === "string" && s.art.length < 700000 ? s.art : null,
          lyrics: s.lyrics || null,
        });
      }
    }
  });
}
for (const ev of ["play", "pause", "seeked", "ratechange", "loadedmetadata", "playing", "ended"]) {
  AS.audio.addEventListener(ev, () => pcSend());
}
// lyrics can show up a moment after the song starts
setInterval(() => {
  if (R.role !== "pc" || !R.room) return;
  const s = P.currentTrack;
  for (const L of R.room.links) if (s && s.lyrics && !L.lyrFor && L.sentFor === s.id) {
    L.lyrFor = s.id;
    L.send({ t: "song", id: s.id, art: null, lyrics: s.lyrics });
  }
  pcSend();
}, 1500);

const fbuf = new Uint8Array(1024);
function pcFrames() {
  // runs on a timer, not the screen refresh, so it keeps going when the PC window is in the background
  if (R.role !== "pc" || !R.room || !R.room.links.size) return;
  const an = AS.analyser;
  if (!an || AS.audio.paused) return;
  if (window.liquidV2 && window.liquidV2.probe) window.liquidV2.probe();
  if (fbuf.length !== an.frequencyBinCount) return;
  an.getByteFrequencyData(fbuf);
  const d = fbuf.slice(0, BINS).buffer;
  const k = window.liquidV2 ? window.liquidV2.kickSeq : 0;
  const ks = window.liquidV2 ? window.liquidV2.kickStr : 1;
  for (const L of R.room.links) if (L.backlog() < 40000) L.send({ t: "v", d, k, ks });
}

function pcMsg(m) {
  if (m.t !== "cmd") return;
  const a = AS.audio;
  if (m.c === "toggle") P.togglePlay();
  else if (m.c === "next") P.next();
  else if (m.c === "prev") P.prev();
  else if (m.c === "loop") P.toggleRepeat();
  else if (m.c === "stop") {
    a.pause();
    a.currentTime = 0;
    window.ui.updatePlayBtn(false);
  } else if (m.c === "seek" && a.duration) a.currentTime = Math.max(0, Math.min(1, m.pct)) * a.duration;
  pcSend();
}

async function startPc() {
  if (R.busy) return;
  R.busy = true;
  render("Starting...");
  try {
    R.room = await host("remote", {
      onJoin: (L) => {
        toast("Phone remote connected 📱");
        L.sentFor = null;
        pcSend();
        render();
      },
      onLeave: () => {
        toast("Phone remote disconnected");
        render();
      },
      onMsg: pcMsg,
    });
    R.role = "pc";
    R.code = R.room.code;
    R.sendTimer = setInterval(pcFrames, 33);
  } catch (e) {
    toast("Couldn't start the remote: " + (e.message || e));
  }
  R.busy = false;
  render();
}
// repeat button state goes to the phone too
const origRepeat = P.toggleRepeat.bind(P);
P.toggleRepeat = (...x) => {
  if (R.role === "phone") return phoneCmd("loop");
  const r = origRepeat(...x);
  pcSend();
  return r;
};

// ================================================================== phone side
function phoneCmd(c, extra) {
  if (R.role !== "phone" || !R.room) return;
  R.room.link.send({ t: "cmd", c, ...extra });
  if (navigator.vibrate) navigator.vibrate(12);
}

function pcTime() {
  const n = R.now;
  if (!n) return 0;
  if (!n.playing) return n.pos;
  const pcNow = performance.now() + R.room.link.offset;
  return Math.min(n.dur || 1e9, n.pos + ((pcNow - n.at) / 1000) * n.rate);
}

// Make the page think it's playing the PC's song, so the normal player screen, progress bar,
// lyrics and visualizer all just work (the phone itself plays no sound).
function fakePlayer() {
  const a = AS.audio;
  a.pause();
  Object.defineProperty(a, "paused", { configurable: true, get: () => !(R.now && R.now.playing) });
  Object.defineProperty(a, "currentTime", { configurable: true, get: pcTime, set() {} });
  Object.defineProperty(a, "duration", { configurable: true, get: () => (R.now && R.now.dur) || NaN });
  AS.analyser = {
    frequencyBinCount: 1024,
    getByteFrequencyData(arr) {
      // levels fade out if the PC stops sending (paused / connection hiccup)
      if (performance.now() - R.lastFrameAt > 250) for (let i = 0; i < R.bins.length; i++) R.bins[i] = R.bins[i] * 0.85;
      arr.set(R.bins.subarray(0, arr.length));
    },
  };
  for (const k of ["togglePlay", "next", "prev"]) P[k] = () => phoneCmd(k === "togglePlay" ? "toggle" : k);
  P.play = () => toast("Pick songs on the PC (this phone is the remote)");
  P.onTick = () => {};
  P.onEnd = () => {};
  document.addEventListener(
    "input",
    (e) => {
      if (!e.target || e.target.id !== "progressBar") return;
      e.stopImmediatePropagation();
      phoneCmd("seek", { pct: e.target.value / 100 });
    },
    true,
  );
  if (window.viz) window.viz.start();
  setInterval(() => {
    window.ui.updateProgress();
    window.ui.updatePlayBtn(!!(R.now && R.now.playing));
  }, 250);
}

function applyLook(n) {
  const root = document.documentElement.style;
  if (n.accent) root.setProperty("--accent", n.accent);
  if (n.glow) root.setProperty("--accent-glow", n.glow);
  if (n.hue) root.setProperty("--bg-hue", n.hue);
  if (window.ui && n.theme) window.ui.themeMode = n.theme;
  const v = window.viz;
  if (v) {
    if (n.mode && v.mode !== n.mode) {
      v.mode = n.mode;
      const art = $("albumArt");
      if (art) art.classList.toggle("circle", n.mode !== "bar");
    }
    v.flash = n.flash !== false;
    v.rippleEffect = n.ripple !== false;
  }
  window.__liquidVerOverride = n.v2 ? "v2" : "v1";
  const loop = $("btnLoop");
  if (loop) loop.style.color = n.loop ? "var(--accent)" : "";
}

const songs = new Map(); // id -> {art, lyrics}
function showSong() {
  const n = R.now;
  if (!n) return;
  const extra = songs.get(n.id) || {};
  const track = { id: n.id || "pc", name: n.name || "Nothing playing", art: extra.art || null, lyrics: extra.lyrics || null };
  const cur = P.currentTrack;
  if (cur && cur.id === track.id && cur.art === track.art && cur.lyrics === track.lyrics) return;
  const sameSong = cur && cur.id === track.id;
  P.currentTrack = track;
  window.ui.setTrack(track);
  // lyrics that arrive later for the same song (setTrack only re-checks on a new song)
  if (sameSong && track.lyrics && window.lyrics && window.lyrics.onTrack) window.lyrics.onTrack(track);
}

function phoneMsg(m) {
  if (m.t === "v") {
    const d = new Uint8Array(m.d);
    R.bins.set(d.subarray(0, Math.min(d.length, R.bins.length)));
    R.lastFrameAt = performance.now();
    if (m.k && m.k !== R.lastK) {
      if (R.lastK !== undefined && window.liquidV2) window.liquidV2.kick(m.ks);
      R.lastK = m.k;
    }
    return;
  }
  if (m.t === "now") {
    const changed = !R.now || R.now.id !== m.id;
    R.now = m;
    applyLook(m);
    if (changed) showSong();
    return;
  }
  if (m.t === "song") {
    const old = songs.get(m.id) || {};
    songs.set(m.id, { art: m.art || old.art || null, lyrics: m.lyrics || old.lyrics || null });
    if (songs.size > 20) songs.delete(songs.keys().next().value);
    if (R.now && R.now.id === m.id) showSong();
  }
}

async function keepAwake() {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible") R.wake = await navigator.wakeLock.request("screen");
  } catch (e) {}
}

async function startPhone(code) {
  code = cleanCode(code);
  if (!code) return toast("Type the code from your PC");
  if (R.busy) return;
  R.busy = true;
  render("Connecting to your PC...");
  try {
    R.room = await join("remote", code, {
      onMsg: phoneMsg,
      onDrop: () => {
        toast("Lost the PC, reconnecting...");
        setTimeout(() => location.reload(), 1500);
      },
    });
    R.role = "phone";
    R.code = code;
    document.body.classList.add("remote-mode");
    fakePlayer();
    keepAwake();
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && keepAwake());
    toggleSheet(false);
    toast("Connected to your PC 🎛️");
    // remember it, so reopening the phone tab reconnects
    const u = new URL(location.href);
    u.searchParams.set("remote", code);
    history.replaceState(null, "", u);
  } catch (e) {
    toast(e.message || "Couldn't connect");
    if (R.role !== "phone") {
      document.body.classList.remove("remote-mode");
      R.busy = false;
      toggleSheet(true);
      return;
    }
  }
  R.busy = false;
  render();
}

function stopRemote() {
  if (R.role === "phone") {
    const u = new URL(location.href);
    u.searchParams.delete("remote");
    location.href = u.toString(); // reload as a normal player
    return;
  }
  clearInterval(R.sendTimer);
  if (R.room) R.room.close();
  R.room = null;
  R.role = null;
  render();
}

// ================================================================== sheet
async function render(busyText) {
  const pb = $("remoteBtn");
  if (pb) pb.classList.toggle("active", R.role === "pc");
  const box = $("remoteBody");
  if (!box) return;
  if (busyText) {
    box.innerHTML = `<div class="jam-wait"><i class="fa-solid fa-spinner fa-spin"></i> ${esc(busyText)}</div>`;
    return;
  }
  if (R.role === "pc") {
    const link = shareLink("remote", R.code);
    const n = R.room.links.size;
    box.innerHTML = `
      <div class="jam-code-wrap">
        <div class="jam-qr" id="remoteQr"></div>
        <div class="jam-code-side">
          <small>Remote code</small>
          <div class="jam-code">${esc(R.code)}</div>
          <p>Scan with your phone's camera. Or open okMUSIC on the phone → ••• → Phone remote → type the code.</p>
          <button class="set-btn" id="remoteCopy"><i class="fa-solid fa-link"></i> Copy link</button>
        </div>
      </div>
      <div class="jam-people"><i class="fa-solid fa-mobile-screen"></i> ${n ? n + " phone" + (n > 1 ? "s" : "") + " connected" : "Waiting for your phone..."}</div>
      <p class="jam-hint">Music keeps playing here on the PC. The phone shows the visuals and has the buttons.</p>
      <button class="set-btn jam-leave" id="remoteStop"><i class="fa-solid fa-xmark"></i> Turn off phone remote</button>`;
    qrSvg(link).then((svg) => $("remoteQr") && ($("remoteQr").innerHTML = svg)).catch(() => {});
    $("remoteCopy").onclick = () => navigator.clipboard.writeText(link).then(() => toast("Link copied"));
    $("remoteStop").onclick = stopRemote;
    return;
  }
  const isPhone = matchMedia("(pointer: coarse)").matches || innerWidth < 800;
  const joinBox = `
    <div class="jam-join">
      <input id="remoteCodeIn" maxlength="8" placeholder="CODE" autocomplete="off" autocapitalize="characters">
      <button class="set-btn" id="remoteJoin">Connect</button>
    </div>`;
  const hostBtn = `<button class="set-btn ${isPhone ? "" : "set-btn-accent"}" id="remoteHost"><i class="fa-solid fa-qrcode"></i> Control this device from my phone</button>`;
  box.innerHTML = isPhone
    ? `<p class="jam-hint">Use this phone as a remote for okMUSIC on your PC: type the code your PC shows (PC: ••• → Phone remote).</p>
       ${joinBox}<div class="jam-or"><span>or</span></div>${hostBtn}`
    : `<p class="jam-hint">Play on this PC, control it from your phone and see the visuals there too.</p>
       ${hostBtn}<div class="jam-or"><span>or use this device as the remote</span></div>${joinBox}`;
  $("remoteHost").onclick = startPc;
  $("remoteJoin").onclick = () => startPhone($("remoteCodeIn").value);
  $("remoteCodeIn").onkeydown = (e) => e.key === "Enter" && startPhone(e.target.value);
}

function toggleSheet(force) {
  if (!$("remoteSheet")) {
    const el = document.createElement("div");
    el.id = "remoteSheet";
    el.className = "jam-sheet";
    el.innerHTML = `
      <div class="jam-card">
        <div class="jam-head">
          <div class="jam-title"><i class="fa-solid fa-mobile-screen-button"></i> Phone remote</div>
          <button class="tuner-icon-btn" id="remoteClose" title="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div id="remoteBody"></div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener("click", (e) => e.target === el && toggleSheet(false));
    $("remoteClose").onclick = () => toggleSheet(false);
  }
  const el = $("remoteSheet");
  const open = force === undefined ? !el.classList.contains("open") : force;
  el.classList.toggle("open", open);
  if (open) render();
}

window.remote = { toggle: toggleSheet, stop: stopRemote, cmd: phoneCmd, _state: R };

// opened from the QR code (…?remote=CODE): connect right away
const pre = new URLSearchParams(location.search).get("remote");
if (pre) {
  document.body.classList.add("remote-mode");
  // don't load the phone's own last song, it'd fight with what the PC shows
  P.restorePlaybackState = () => {};
  setTimeout(() => startPhone(pre), 300);
}
