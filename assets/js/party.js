// okMUSIC Jam (party mode): two+ devices play the same song at the same moment.
//
// - One person starts a jam (the host), the other scans the QR / types the code.
// - The host's okMUSIC is the "boss": it says which song, where in the song, playing or paused.
// - If the guest doesn't have the song, the host sends the file straight over (device to
//   device, a few seconds on the same wifi). The guest can pick songs too: their pick gets
//   sent to the host and added to the host's library.
// - Staying in sync: both devices agree on the time (measured over the connection like a
//   tiny ping test), then the guest keeps nudging its playback a hair faster/slower so it
//   lines up to within ~10-20ms. A big jump (seek, lag spike) gets fixed by jumping too.
// Replaces the old Firebase party mode (that database is locked, so it never connected).

import { host, join, cleanCode, qrSvg, shareLink } from "./link.js?v=2.19.2";

const $ = (id) => document.getElementById(id);
const toast = (m) => window.ui && window.ui.showToast(m);
const P = window.player;
const AS = window.audioSys;
const A = () => AS.audio;
const norm = (s) => (s || "").toLowerCase().replace(/\.[a-z0-9]{2,4}$/, "").replace(/[^a-z0-9]+/g, " ").trim();
const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const J = {
  role: null, // "host" | "guest" | null
  room: null,
  code: "",
  busy: false,
  nudge: parseInt(localStorage.getItem("sv_party_sync")) || 0, // ms, + = this device plays later
  // guest only
  hs: null, // last state from the host
  cache: new Map(), // host song id -> { blob, name, art }
  arts: new Map(),
  wanted: null,
  curId: null,
  prevId: null,
  seekFix: 0.04, // how long a jump takes to actually happen on this device (learned)
  lastSeek: 0,
  checkSeek: 0,
  drift: 0,
  status: "",
  syncTimer: 0,
  hostTimer: 0,
};

// what the speakers lag behind the song position (bluetooth etc.), in seconds
function outLat() {
  const c = AS.ctx;
  return c ? (c.outputLatency || 0) + (c.baseLatency || 0) : 0;
}

// ================================================================== HOST
function stateMsg() {
  const a = A();
  const s = P.currentTrack;
  return {
    t: "state",
    id: s ? s.id : null,
    name: s ? s.name : "",
    playing: !!(s && !a.paused && !a.ended),
    pos: a.currentTime || 0,
    at: performance.now(),
    rate: a.playbackRate || 1,
    lat: outLat(),
    dur: isFinite(a.duration) ? a.duration : 0,
    ev: J.ev, // goes up only when someone actually DOES something (play/pause/seek/skip)
  };
}
function fxMsg() {
  return { t: "fx", bass: AS.bassVal, reverb: AS.reverbVal, xtreme: AS.xtremeOn };
}
function hostSend(m) {
  if (J.role !== "host" || !J.room) return;
  for (const L of J.room.links) L.send(m);
}
let stateQueued = false;
function hostState() {
  if (J.role !== "host" || stateQueued) return;
  stateQueued = true;
  queueMicrotask(() => {
    stateQueued = false;
    if (!J.room || !J.room.links.size) return;
    const m = stateMsg();
    const s = P.currentTrack;
    for (const L of J.room.links) {
      L.send(m);
      // cover art once per song (it's big-ish)
      if (s && L.artFor !== s.id) {
        L.artFor = s.id;
        if (typeof s.art === "string" && s.art.length < 700000) L.send({ t: "art", id: s.id, art: s.art });
      }
    }
  });
}
J.ev = 1;
for (const ev of ["play", "pause", "seeked", "loadedmetadata", "ended"]) {
  A().addEventListener(ev, () => {
    if (J.role !== "host") return;
    J.ev++;
    hostState();
  });
}
// speed changes (speed curve) just pass the new speed along, no re-sync
A().addEventListener("ratechange", () => J.role === "host" && hostState());

function findSong(id, name) {
  const list = P.songs || [];
  return list.find((s) => s.id === id) || (name ? list.find((s) => norm(s.name) === norm(name)) : null);
}

async function hostMsg(m, L) {
  if (m.t === "want") {
    const s = findSong(m.id);
    if (!s || !s.blob) return L.send({ t: "missing", id: m.id });
    if (L.sending === m.id) return;
    L.sending = m.id;
    try {
      await L.sendFile({ id: s.id, name: s.name, art: typeof s.art === "string" && s.art.length < 700000 ? s.art : null }, s.blob);
    } catch (e) {
      console.warn("jam: send failed", e);
    }
    L.sending = null;
    return;
  }
  if (m.t === "cmd") {
    const a = A();
    if (m.c === "toggle") orig.togglePlay();
    else if (m.c === "next") orig.next();
    else if (m.c === "prev") orig.prev();
    else if (m.c === "seek" && a.duration) a.currentTime = Math.max(0, Math.min(1, m.pct)) * a.duration;
    else if (m.c === "play") {
      const s = findSong(m.id, m.name);
      if (s) orig.play(s.id);
      else {
        toast("Getting " + (m.name || "a song") + " from your friend...");
        L.send({ t: "want", id: m.id });
      }
    }
    return;
  }
  if (m.t === "fileDone") {
    // a guest sent us their song: keep it in the library and play it
    try {
      const f = new File([m.blob], (m.meta.name || "song") + ".mp3", { type: m.blob.type });
      const id = await P.db.add(f);
      if (m.meta.art) await P.db.update(id, { art: m.meta.art });
      await P.loadLib();
      orig.play(id);
      toast("Added + playing: " + m.meta.name);
    } catch (e) {
      toast("Couldn't add your friend's song");
    }
    return;
  }
  if (m.t === "fileFailed") toast("A song from your friend didn't come through, try again");
}

async function startHost() {
  if (J.busy) return;
  J.busy = true;
  render("Starting...");
  try {
    AS.init();
    J.room = await host("jam", {
      onJoin: (L) => {
        toast("Someone joined the jam 🎉");
        L.artFor = null;
        L.send(stateMsg());
        L.send(fxMsg());
        hostState();
        render();
      },
      onLeave: () => {
        toast("Someone left the jam");
        render();
      },
      onMsg: hostMsg,
    });
    J.role = "host";
    J.code = J.room.code;
    // steady heartbeat so guests never drift far, even with nothing happening
    J.hostTimer = setInterval(() => !A().paused && hostState(), 3000);
    setBadge();
  } catch (e) {
    toast("Couldn't start the jam: " + (e.message || e));
  }
  J.busy = false;
  render();
}

// ================================================================== GUEST
function guestSend(m) {
  return J.role === "guest" && J.room && J.room.link.send(m);
}

function setStatus(s) {
  J.status = s;
  const el = $("jamStatus");
  if (el) el.textContent = s;
}

function loadHostSong() {
  const h = J.hs;
  if (!h || !h.id || J.curId === h.id) return;
  const local = findSong(h.id, h.name);
  let blob = local && local.blob;
  let name = h.name;
  let art = (local && local.art) || J.arts.get(h.id) || null;
  const c = J.cache.get(h.id);
  if (!blob && c) {
    blob = c.blob;
    art = art || c.art;
  }
  if (!blob) {
    if (J.wanted !== h.id) {
      J.wanted = h.id;
      guestSend({ t: "want", id: h.id });
      setStatus("Getting the song from the host...");
    }
    return;
  }
  J.curId = h.id;
  J.wanted = null;
  const a = A();
  a.pause();
  P.setAudioSource(blob);
  a.preservesPitch = false;
  const track = { id: h.id, name, art, blob, beatSignals: (local && local.beatSignals) || [], speedPoints: [] };
  if (local && local.lyrics) track.lyrics = local.lyrics;
  P.currentTrack = track;
  window.ui.setTrack(track);
  J.checkSeek = 0;
  setStatus("In sync");
}

// Guest playback: the song just plays on its own, like you picked it yourself. It only lines
// up with the host ONCE when someone does something (play, pause, skip, seek, new song),
// plus one small touch-up a second later if that jump landed off. No constant nudging
// (that's what made it play 2s, glitch, play 2s on phones).
function setRate(r) {
  const a = A();
  r = Math.round(r * 10000) / 10000;
  if (Math.abs(a.playbackRate - r) > 0.00005) a.playbackRate = r;
}
function hostTarget() {
  const h = J.hs;
  const hostNow = performance.now() + J.room.link.offset;
  let t = h.pos + (h.playing ? ((hostNow - h.at) / 1000) * h.rate : 0);
  // line up what comes out of the SPEAKERS (bluetooth etc), not just the song position
  t += (outLat() - (h.lat || 0)) * h.rate - J.nudge / 1000;
  return Math.max(0, t);
}
function guestSync() {
  const h = J.hs;
  const a = A();
  if (J.role !== "guest" || !h) return;
  if (!h.id) {
    if (!a.paused) a.pause();
    return;
  }
  if (J.curId !== h.id || a.readyState < 1) return;
  setRate(h.rate);
  const now = performance.now();
  const fresh = J.syncedEv !== h.ev || J.syncedId !== h.id;
  if (fresh) {
    J.syncedEv = h.ev;
    J.syncedId = h.id;
    const target = hostTarget();
    if (!h.playing) {
      if (!a.paused) a.pause();
      a.currentTime = target;
      window.ui.updatePlayBtn(false);
      J.touchUpAt = 0;
    } else {
      a.currentTime = target + J.seekFix;
      if (a.paused) a.play().catch(() => setStatus("Tap anywhere to start the sound"));
      window.ui.updatePlayBtn(true);
      J.touchUpAt = now + 1200;
    }
    return;
  }
  // one touch-up after the jump settled (and learn how slow jumps are on this device)
  if (J.touchUpAt && now > J.touchUpAt && h.playing && !a.paused) {
    J.touchUpAt = 0;
    const drift = hostTarget() - a.currentTime; // + = we're behind
    J.seekFix = Math.max(0, Math.min(0.35, J.seekFix + drift * 0.7));
    if (Math.abs(drift) > 0.08) a.currentTime = hostTarget() + J.seekFix;
    const ms = Math.round(Math.abs(drift) * 1000);
    const el = $("jamDrift");
    if (el) el.textContent = ms < 80 ? "in sync" : `fixed ${ms}ms`;
  }
  // the host's song is playing but ours stopped (phone paused it, call came in...): catch up once
  if (h.playing && a.paused && !J.touchUpAt && a.readyState >= 2 && now - (J.retryAt || 0) > 3000) {
    J.retryAt = now;
    J.syncedEv = -1;
  }
}

function applyFx(m) {
  if (!AS.ctx) return;
  if (m.bass !== undefined) {
    AS.bassVal = m.bass;
    AS.updateDynamicBass && AS.updateDynamicBass();
  }
  if (m.reverb !== undefined) AS.revGain.gain.value = m.reverb / 50;
  if (m.xtreme !== undefined) {
    AS.bass.type = m.xtreme ? "peaking" : "lowshelf";
    AS.bass.frequency.value = m.xtreme ? 60 : 200;
    AS.bass.Q.value = m.xtreme ? 1.5 : 1;
  }
  window.ui.updateMetaTags && window.ui.updateMetaTags();
}

function guestMsg(m, L) {
  if (m.t === "state") {
    J.hs = m;
    loadHostSong();
    guestSync();
    return;
  }
  if (m.t === "art") {
    J.arts.set(m.id, m.art);
    if (J.curId === m.id && P.currentTrack && !P.currentTrack.art) {
      P.currentTrack.art = m.art;
      window.ui.setTrack(P.currentTrack);
    }
    return;
  }
  if (m.t === "fx") return localStorage.getItem("sv_host_fx") === "false" ? null : applyFx(m);
  if (m.t === "fileStart") return setStatus("Getting the song... 0%");
  if (m.t === "fileProgress") return setStatus(`Getting the song... ${m.pct}%`);
  if (m.t === "fileDone") {
    J.cache.set(m.id, { blob: m.blob, name: m.meta.name, art: m.meta.art });
    // keep only the last few songs in memory
    if (J.cache.size > 6) J.cache.delete(J.cache.keys().next().value);
    if (m.meta.art) J.arts.set(m.id, m.meta.art);
    J.wanted = null;
    loadHostSong();
    guestSync();
    return;
  }
  if (m.t === "fileFailed") {
    J.wanted = null;
    setStatus("Song didn't come through, retrying...");
    setTimeout(loadHostSong, 500);
    return;
  }
  if (m.t === "missing") return setStatus("The host doesn't have that song anymore");
  if (m.t === "want") {
    // the host wants a song we picked
    const s = findSong(m.id);
    if (s && s.blob) {
      toast("Sending your song to the host...");
      L.sendFile({ id: s.id, name: s.name, art: typeof s.art === "string" && s.art.length < 700000 ? s.art : null }, s.blob).catch(() => toast("Sending failed"));
    }
  }
}

async function startGuest(code) {
  code = cleanCode(code);
  if (!code) return toast("Type the code from the host's screen");
  if (J.busy) return;
  J.busy = true;
  render("Connecting...");
  // this tap unlocks sound on phones (they only allow sound that starts from a tap)
  AS.init();
  if (AS.ctx && AS.ctx.state === "suspended") AS.ctx.resume();
  const a = A();
  J.prevId = P.currId;
  try {
    if (!a.src) {
      a.muted = true;
      a.play().catch(() => {}).finally(() => {
        a.pause();
        a.muted = false;
      });
    } else a.pause();
  } catch (e) {}
  try {
    J.room = await join("jam", code, {
      onMsg: guestMsg,
      onDrop: () => {
        if (J.role === "guest") {
          toast("The jam ended");
          leave(true);
        }
      },
    });
    J.role = "guest";
    J.code = code;
    J.syncTimer = setInterval(guestSync, 300);
    toast("Joined the jam 🎶");
    setBadge();
  } catch (e) {
    toast(e.message || "Couldn't join");
  }
  J.busy = false;
  render();
}

function leave(dropped) {
  const wasGuest = J.role === "guest";
  clearInterval(J.syncTimer);
  clearInterval(J.hostTimer);
  if (J.room && !dropped) J.room.close();
  J.room = null;
  J.role = null;
  J.hs = null;
  J.curId = null;
  J.wanted = null;
  J.syncedEv = J.syncedId = null;
  J.touchUpAt = 0;
  if (wasGuest) {
    const a = A();
    a.pause();
    a.playbackRate = AS.baseSpeed || 1;
    // back to your own song (paused)
    if (J.prevId && findSong(J.prevId)) {
      orig.play(J.prevId);
      a.pause();
    }
    window.ui.updatePlayBtn(false);
  }
  setBadge();
  render();
}

// ================================================================== take over the controls while you're a guest
const orig = {
  togglePlay: P.togglePlay.bind(P),
  next: P.next.bind(P),
  prev: P.prev.bind(P),
  play: P.play.bind(P),
  onTick: P.onTick.bind(P),
  onEnd: P.onEnd.bind(P),
};
P.togglePlay = (...x) => (J.role === "guest" ? guestSend({ t: "cmd", c: "toggle" }) : orig.togglePlay(...x));
P.next = (...x) => (J.role === "guest" ? guestSend({ t: "cmd", c: "next" }) : orig.next(...x));
P.prev = (...x) => (J.role === "guest" ? guestSend({ t: "cmd", c: "prev" }) : orig.prev(...x));
P.play = (id, ...x) => {
  if (J.role !== "guest") return orig.play(id, ...x);
  const s = findSong(id);
  if (s) {
    guestSend({ t: "cmd", c: "play", id: s.id, name: s.name });
    toast("Asked the host to play " + s.name);
  }
};
// the host decides speed + when songs end
P.onTick = (...x) => (J.role === "guest" ? window.ui.updateProgress() : orig.onTick(...x));
P.onEnd = (...x) => (J.role === "guest" ? null : orig.onEnd(...x));
document.addEventListener(
  "input",
  (e) => {
    if (J.role !== "guest" || !e.target || e.target.id !== "progressBar") return;
    e.stopImmediatePropagation();
    guestSend({ t: "cmd", c: "seek", pct: e.target.value / 100 });
  },
  true,
);

// ================================================================== UI
function setBadge() {
  const st = $("syncStatus");
  const btn = $("partyBtn");
  if (btn) btn.classList.toggle("active", !!J.role);
  if (!st) return;
  if (J.role) {
    st.textContent = J.role === "host" ? `Jam ${J.code} · ${J.room ? J.room.links.size : 0} joined` : `In jam ${J.code}`;
    st.style.display = "inline-block";
  } else st.style.display = "none";
}

async function render(busyText) {
  setBadge();
  const box = $("jamBody");
  if (!box) return;
  if (busyText) {
    box.innerHTML = `<div class="jam-wait"><i class="fa-solid fa-spinner fa-spin"></i> ${esc(busyText)}</div>`;
    return;
  }
  const nudge = `<div class="jam-nudge">
      <div class="jam-row"><span>Fine-tune sync</span><b id="jamNudgeVal">${J.nudge}ms</b></div>
      <input type="range" class="setting-slider" id="jamNudge" min="-300" max="300" step="5" value="${J.nudge}">
      <p>Only if this device sounds early or late. Move right if it's ahead.</p>
    </div>`;
  if (J.role === "host") {
    const link = shareLink("jam", J.code);
    const n = J.room.links.size;
    box.innerHTML = `
      <div class="jam-code-wrap">
        <div class="jam-qr" id="jamQr"></div>
        <div class="jam-code-side">
          <small>Jam code</small>
          <div class="jam-code">${esc(J.code)}</div>
          <p>Scan with the other phone, or open okMUSIC there → ••• → Jam → type the code.</p>
          <button class="set-btn" id="jamCopy"><i class="fa-solid fa-link"></i> Copy invite link</button>
        </div>
      </div>
      <div class="jam-people"><i class="fa-solid fa-user-group"></i> ${n ? n + " listening with you" : "Waiting for someone to join..."}</div>
      <p class="jam-hint">You pick the songs (they can too). Songs they don't have get sent to them automatically.</p>
      <button class="set-btn jam-leave" id="jamLeave"><i class="fa-solid fa-xmark"></i> End jam</button>`;
    qrSvg(link).then((svg) => $("jamQr") && ($("jamQr").innerHTML = svg)).catch(() => {});
    $("jamCopy").onclick = () => navigator.clipboard.writeText(link).then(() => toast("Invite link copied"));
    $("jamLeave").onclick = () => leave();
    return;
  }
  if (J.role === "guest") {
    box.innerHTML = `
      <div class="jam-people"><i class="fa-solid fa-tower-broadcast"></i> In jam <b>${esc(J.code)}</b></div>
      <div class="jam-status"><span id="jamStatus">${esc(J.status || "Waiting for the host to play something...")}</span> · <span id="jamDrift"></span></div>
      ${nudge}
      <p class="jam-hint">Play / pause / skip work for both of you. Tapping a song in your library asks the host to play it.</p>
      <button class="set-btn jam-leave" id="jamLeave"><i class="fa-solid fa-right-from-bracket"></i> Leave jam</button>`;
    bindNudge();
    $("jamLeave").onclick = () => leave();
    return;
  }
  const pre = new URLSearchParams(location.search).get("jam") || "";
  box.innerHTML = `
    <p class="jam-hint">Listen together on two devices at the exact same time, like Spotify Jam. Works on PC and phone.</p>
    <button class="set-btn set-btn-accent" id="jamHost"><i class="fa-solid fa-tower-broadcast"></i> Start a jam</button>
    <div class="jam-or"><span>or join one</span></div>
    <div class="jam-join">
      <input id="jamCodeIn" maxlength="8" placeholder="CODE" autocomplete="off" autocapitalize="characters" value="${esc(cleanCode(pre))}">
      <button class="set-btn" id="jamJoin">Join</button>
    </div>`;
  $("jamHost").onclick = startHost;
  $("jamJoin").onclick = () => startGuest($("jamCodeIn").value);
  $("jamCodeIn").onkeydown = (e) => e.key === "Enter" && startGuest(e.target.value);
}
function bindNudge() {
  const r = $("jamNudge");
  if (!r) return;
  r.oninput = () => {
    J.nudge = parseInt(r.value) || 0;
    $("jamNudgeVal").textContent = J.nudge + "ms";
    localStorage.setItem("sv_party_sync", J.nudge);
    const s = $("syncOffsetSlider");
    if (s) s.value = J.nudge;
    const v = $("syncOffsetVal");
    if (v) v.textContent = J.nudge + "ms";
  };
  window.uiv3 && window.uiv3.paintAll && window.uiv3.paintAll();
}

function buildSheet() {
  if ($("jamSheet")) return;
  const el = document.createElement("div");
  el.id = "jamSheet";
  el.className = "jam-sheet";
  el.innerHTML = `
    <div class="jam-card">
      <div class="jam-head">
        <div class="jam-title"><i class="fa-solid fa-satellite-dish"></i> Jam</div>
        <button class="tuner-icon-btn" id="jamClose" title="Close"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div id="jamBody"></div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener("click", (e) => e.target === el && toggleSetup(false));
  $("jamClose").onclick = () => toggleSetup(false);
}
function toggleSetup(force) {
  buildSheet();
  const el = $("jamSheet");
  const open = force === undefined ? !el.classList.contains("open") : force;
  el.classList.toggle("open", open);
  if (open) render();
}

// ================================================================== the old API other code still calls
window.partyMode = {
  toggleSetup,
  get active() {
    return !!J.role;
  },
  get isHost() {
    return J.role === "host";
  },
  get hostFxOverride() {
    return localStorage.getItem("sv_host_fx") !== "false";
  },
  set hostFxOverride(v) {},
  get manualOffset() {
    return J.nudge;
  },
  set manualOffset(v) {
    J.nudge = parseInt(v) || 0;
  },
  // app.js calls this when the host changes bass / reverb / xtreme
  broadcast(d) {
    if (d && d.type === "FX_SYNC") hostSend({ t: "fx", bass: d.bass, reverb: d.reverb, xtreme: d.xtreme });
  },
  broadcastInChunks() {},
  leave: () => leave(),
  _state: J,
};

// opened from an invite link (…?jam=CODE): show the sheet ready to join (a tap is needed for sound)
if (new URLSearchParams(location.search).get("jam")) setTimeout(() => toggleSetup(true), 600);
