// okMUSIC v2.20.0 "High End" mode: extra stuff for strong PCs, all behind one switch in Settings.
//
//  - Studio EQ: 10 bands (31 Hz - 16 kHz, +-12 dB) + presets
//  - Loudness Match: every song plays equally loud (measures each song like Spotify does, LUFS),
//    remembers each song's level so the 2nd play is right from the first second
//  - Anti-Clip Limiter: no crackle when bass boost / volume go past what speakers can take
//  - 3D Wide: makes the stereo wider (or narrower / mono)
//  - 8D Audio: the sound slowly circles around your head (headphones)
//  - dB Meter: live left/right level in dB, peak hold, loudness, limiter, clip light
//  - Ultra Visuals: draws the visualizer at your screen's full sharpness, never lowers it
//
// Sound path: ...song FX -> your volume -> [High End chain] -> speakers. Off = the chain is
// unplugged completely, so the sound is exactly like before.

const $ = (id) => document.getElementById(id);
const KEY = "okmusic_hi";
const LOUD_KEY = "okmusic_loud";
const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  phonk: [5, 6, 3, 0, -2, -1, 1, 3, 4, 3],
  basshead: [8, 7, 5, 2, 0, 0, 0, 0, 1, 1],
  club: [6, 5, 3, 0, -1, 0, 1, 2, 3, 2],
  vocal: [-2, -1, 0, 1, 3, 4, 4, 2, 1, 0],
  bright: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  night: [3, 2, 1, 0, 0, 0, -1, -2, -3, -4],
};
const PRESET_NAMES = { flat: "Flat", phonk: "Phonk", basshead: "Bass Head", club: "Club", vocal: "Vocal", bright: "Bright", night: "Late Night" };
const TARGET = -14; // LUFS, same as Spotify / YouTube

const DEF = { on: false, eq: PRESETS.flat.slice(), preset: "flat", norm: true, limit: true, width: 100, d8: false, meter: true, ultra: true };
let S = load();

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && typeof s === "object") {
      const out = Object.assign({}, DEF, s);
      if (!Array.isArray(out.eq) || out.eq.length !== 10) out.eq = PRESETS.flat.slice();
      return out;
    }
  } catch (e) {}
  return Object.assign({}, DEF, { eq: PRESETS.flat.slice() });
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(S));
  } catch (e) {}
}
const db2 = (d) => Math.pow(10, d / 20);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------ the sound chain
let G = null; // nodes, built once the player's sound engine exists
function build() {
  const as = window.audioSys;
  if (G || !as || !as.ctx || !as.gain) return !!G;
  const c = as.ctx;
  const n = {};
  n.input = c.createGain();
  // EQ: shelves at the ends, bells in between (Q 1.4 = about one octave wide)
  n.eq = BANDS.map((f, i) => {
    const b = c.createBiquadFilter();
    b.type = i === 0 ? "lowshelf" : i === BANDS.length - 1 ? "highshelf" : "peaking";
    b.frequency.value = f;
    if (b.type === "peaking") b.Q.value = 1.4;
    b.gain.value = 0;
    return b;
  });
  // 3D wide: mid/side. L' = L*a + R*b, R' = R*a + L*b, a = (1+w)/2, b = (1-w)/2
  n.split = c.createChannelSplitter(2);
  n.merge = c.createChannelMerger(2);
  n.ll = c.createGain();
  n.rr = c.createGain();
  n.lr = c.createGain();
  n.rl = c.createGain();
  n.split.connect(n.ll, 0);
  n.split.connect(n.lr, 0);
  n.split.connect(n.rr, 1);
  n.split.connect(n.rl, 1);
  n.ll.connect(n.merge, 0, 0);
  n.rl.connect(n.merge, 0, 0);
  n.rr.connect(n.merge, 0, 1);
  n.lr.connect(n.merge, 0, 1);
  // 8D: a slow wobble moves the sound left <-> right
  n.pan = c.createStereoPanner ? c.createStereoPanner() : null;
  if (n.pan) {
    n.lfo = c.createOscillator();
    n.lfo.frequency.value = 0.11; // one lap every ~9 s
    n.depth = c.createGain();
    n.depth.gain.value = 0;
    n.lfo.connect(n.depth);
    n.depth.connect(n.pan.pan);
    n.lfo.start();
  }
  n.norm = c.createGain(); // loudness match
  n.lim = c.createDynamicsCompressor(); // anti-clip
  n.lim.knee.value = 0;
  n.lim.attack.value = 0.002;
  n.lim.release.value = 0.12;
  n.out = c.createGain();

  let last = n.input;
  for (const b of n.eq) {
    last.connect(b);
    last = b;
  }
  last.connect(n.split);
  last = n.merge;
  if (n.pan) {
    last.connect(n.pan);
    last = n.pan;
  }
  last.connect(n.norm);
  n.norm.connect(n.lim);
  n.lim.connect(n.out);

  // meter taps (what actually goes to your speakers)
  n.mSplit = c.createChannelSplitter(2);
  n.anL = c.createAnalyser();
  n.anR = c.createAnalyser();
  n.anL.fftSize = n.anR.fftSize = 2048;
  n.out.connect(n.mSplit);
  n.mSplit.connect(n.anL, 0);
  n.mSplit.connect(n.anR, 1);

  // loudness: the raw song through a "how loud it feels to ears" filter (K-weighting, like LUFS)
  n.kHp = c.createBiquadFilter();
  n.kHp.type = "highpass";
  n.kHp.frequency.value = 60;
  n.kHp.Q.value = 0.5;
  n.kSh = c.createBiquadFilter();
  n.kSh.type = "highshelf";
  n.kSh.frequency.value = 1500;
  n.kSh.gain.value = 4;
  n.kAn = c.createAnalyser();
  n.kAn.fftSize = 4096;
  as.src.connect(n.kHp);
  n.kHp.connect(n.kSh);
  n.kSh.connect(n.kAn);

  G = n;
  wire();
  applyAll(true);
  watchSongs();
  return true;
}

// plug the chain in (on) or take it out (off) between your volume and the speakers
let wired = null;
function wire() {
  const as = window.audioSys;
  if (!G || !as || !as.gain) return;
  const want = !!S.on;
  if (wired === want) return;
  try {
    as.gain.disconnect();
  } catch (e) {}
  try {
    G.out.disconnect(as.ctx.destination);
  } catch (e) {}
  if (want) {
    as.gain.connect(G.input);
    G.out.connect(as.ctx.destination);
  } else as.gain.connect(as.ctx.destination);
  wired = want;
}

function ramp(param, v, tc = 0.05) {
  const c = window.audioSys.ctx;
  param.cancelScheduledValues(c.currentTime);
  param.setTargetAtTime(v, c.currentTime, tc);
}

function applyAll(instant) {
  if (!G) return;
  const tc = instant ? 0.01 : 0.05;
  G.eq.forEach((b, i) => ramp(b.gain, clamp(+S.eq[i] || 0, -12, 12), tc));
  const w = clamp(S.width, 0, 200) / 100;
  ramp(G.ll.gain, (1 + w) / 2, tc);
  ramp(G.rr.gain, (1 + w) / 2, tc);
  ramp(G.lr.gain, (1 - w) / 2, tc);
  ramp(G.rl.gain, (1 - w) / 2, tc);
  if (G.depth) ramp(G.depth.gain, S.d8 ? 0.85 : 0, 0.4);
  // limiter off = ratio 1 (does nothing)
  G.lim.threshold.value = S.limit ? -1.5 : 0;
  G.lim.ratio.value = S.limit ? 20 : 1;
  if (!S.norm) ramp(G.norm.gain, 1, 0.3);
  else if (L.n >= 20 || L.known != null) ramp(G.norm.gain, db2(matchDb()), 0.3);
  // EQ boosts make it louder: pull the whole thing down by half the biggest boost so it doesn't clip
  const top = Math.max(0, ...S.eq.map((v) => +v || 0));
  ramp(G.input.gain, db2(-top * 0.5), tc);
}

// ------------------------------------------------------------------ loudness match
const L = { sum: 0, n: 0, id: null, known: null, buf: null, lufs: null };
function loudMap() {
  try {
    return JSON.parse(localStorage.getItem(LOUD_KEY) || "{}") || {};
  } catch (e) {
    return {};
  }
}
function trackId() {
  const p = window.player;
  return p && p.currentTrack ? String(p.currentTrack.id) : null;
}
function matchDb() {
  const lufs = L.n >= 20 ? L.lufs : L.known;
  if (lufs == null) return 0;
  return clamp(TARGET - lufs, -12, 9);
}
function newSong() {
  const id = trackId();
  if (id === L.id) return;
  L.id = id;
  L.sum = 0;
  L.n = 0;
  L.lufs = null;
  L.known = id != null ? loudMap()[id] ?? null : null;
  if (G && S.norm) ramp(G.norm.gain, db2(L.known != null ? matchDb() : 0), 0.15);
}
function measure() {
  const as = window.audioSys;
  if (!G || !as || !as.audio || as.audio.paused) return;
  if (trackId() !== L.id) newSong();
  if (!L.buf) L.buf = new Float32Array(G.kAn.fftSize);
  G.kAn.getFloatTimeDomainData(L.buf);
  let ms = 0;
  for (let i = 0; i < L.buf.length; i++) ms += L.buf[i] * L.buf[i];
  ms /= L.buf.length;
  const blockLufs = -0.691 + 10 * Math.log10(ms + 1e-12) + 3; // +3: the analyser hears L+R mixed to one
  if (blockLufs < -60) return; // silence doesn't count (same as real LUFS gating)
  if (L.n >= 20 && blockLufs < L.lufs - 10) return; // quiet parts don't count either
  L.sum += ms;
  L.n++;
  L.lufs = -0.691 + 10 * Math.log10(L.sum / L.n + 1e-12) + 3;
  if (!S.norm) return;
  if (L.n === 20 || L.n % 10 === 0) ramp(G.norm.gain, db2(matchDb()), L.known == null && L.n < 80 ? 0.6 : 2.5);
  if (L.id && L.n % 100 === 0) {
    const m = loudMap();
    m[L.id] = Math.round(L.lufs * 10) / 10;
    const keys = Object.keys(m);
    if (keys.length > 800) keys.slice(0, keys.length - 800).forEach((k) => delete m[k]);
    try {
      localStorage.setItem(LOUD_KEY, JSON.stringify(m));
    } catch (e) {}
  }
}
function watchSongs() {
  const a = window.audioSys.audio;
  a.addEventListener("loadedmetadata", () => setTimeout(newSong, 0));
  setInterval(measure, 100);
}

// ------------------------------------------------------------------ dB meter
const M = { raf: 0, bufL: null, bufR: null, hold: [-90, -90], holdAt: [0, 0], clipAt: 0, sm: [-90, -90] };
function meterEl() {
  let el = $("hiMeter");
  if (el) return el;
  el = document.createElement("div");
  el.id = "hiMeter";
  el.className = "hi-meter";
  el.innerHTML = `
    <div class="hm-head"><span>dB</span><span class="hm-clip" id="hmClip">CLIP</span></div>
    ${["L", "R"]
      .map(
        (ch, i) => `<div class="hm-row"><b>${ch}</b><div class="hm-bar"><i id="hmFill${i}"></i><s id="hmHold${i}"></s></div><span id="hmVal${i}">-inf</span></div>`
      )
      .join("")}
    <div class="hm-scale">${[-48, -24, -12, -6, 0].map((d) => `<span style="left:${pct(d)}%">${d}</span>`).join("")}</div>
    <div class="hm-info"><span>Loudness <b id="hmLufs">--</b></span><span>Match <b id="hmMatch">--</b></span><span>Limiter <b id="hmLim">0.0</b></span></div>`;
  document.body.appendChild(el);
  return el;
}
const pct = (d) => clamp(((d + 48) / 48) * 100, 0, 100);
function meterFrame(now) {
  M.raf = 0;
  if (!S.on || !S.meter || !G) return;
  M.raf = requestAnimationFrame(meterFrame);
  if (document.hidden) return;
  const ans = [G.anL, G.anR];
  if (!M.bufL) {
    M.bufL = new Float32Array(G.anL.fftSize);
    M.bufR = new Float32Array(G.anR.fftSize);
  }
  [M.bufL, M.bufR].forEach((buf, i) => {
    ans[i].getFloatTimeDomainData(buf);
    let pk = 0;
    for (let k = 0; k < buf.length; k++) {
      const v = Math.abs(buf[k]);
      if (v > pk) pk = v;
    }
    const d = 20 * Math.log10(pk + 1e-9);
    // fast up, smooth down (like a real meter)
    M.sm[i] = d > M.sm[i] ? d : M.sm[i] - 0.9;
    if (d >= M.hold[i] || now - M.holdAt[i] > 1200) {
      M.hold[i] = Math.max(d, M.hold[i] - 0.6);
      if (d >= M.hold[i]) M.holdAt[i] = now;
    }
    if (pk >= 0.999) M.clipAt = now;
    $("hmFill" + i).style.clipPath = `inset(0 ${100 - pct(M.sm[i])}% 0 0)`;
    $("hmHold" + i).style.left = pct(M.hold[i]) + "%";
    $("hmVal" + i).textContent = M.sm[i] < -60 ? "-inf" : M.sm[i].toFixed(1);
  });
  $("hmClip").classList.toggle("on", now - M.clipAt < 900);
  const lu = L.n >= 20 ? L.lufs : L.known;
  $("hmLufs").textContent = lu != null ? lu.toFixed(1) + " LUFS" : "--";
  const md = matchDb();
  $("hmMatch").textContent = !S.norm ? "off" : (md >= 0 ? "+" : "") + md.toFixed(1) + " dB";
  $("hmLim").textContent = S.limit ? (Math.abs(G.lim.reduction) < 0.05 ? "0.0" : G.lim.reduction.toFixed(1)) + " dB" : "off";
}
function syncMeter() {
  const show = S.on && S.meter && !!G;
  const el = show ? meterEl() : $("hiMeter");
  if (el) el.classList.toggle("show", show);
  if (show && !M.raf) M.raf = requestAnimationFrame(meterFrame);
}

// ------------------------------------------------------------------ ultra visuals
function ultra() {
  return !!(S.on && S.ultra);
}
function syncUltra() {
  if (window.viz && window.viz.resize) window.viz.resize();
}

// ------------------------------------------------------------------ settings UI
function eqUi() {
  const box = $("hiEq");
  if (!box || box.childElementCount) return;
  box.innerHTML = BANDS.map(
    (f, i) => `<label class="hi-band"><span class="hi-band-val" id="hiEqV${i}">0</span>
      <input type="range" min="-12" max="12" step="0.5" value="0" id="hiEq${i}" aria-label="${f < 1000 ? f + " Hz" : f / 1000 + " kHz"}">
      <span class="hi-band-f">${f < 1000 ? f : f / 1000 + "k"}</span></label>`
  ).join("");
  BANDS.forEach((f, i) => {
    $("hiEq" + i).addEventListener("input", (e) => {
      S.eq[i] = +e.target.value;
      S.preset = "custom";
      applyAll();
      syncUi();
      save();
    });
    // double-click a band = back to 0
    $("hiEq" + i).addEventListener("dblclick", () => {
      S.eq[i] = 0;
      S.preset = "custom";
      applyAll();
      syncUi();
      save();
    });
  });
  const chips = $("hiPresets");
  chips.innerHTML = Object.keys(PRESETS)
    .map((k) => `<button type="button" class="chip" data-p="${k}">${PRESET_NAMES[k]}</button>`)
    .join("");
  chips.addEventListener("click", (e) => {
    const b = e.target.closest("[data-p]");
    if (b) setPreset(b.dataset.p);
  });
}
function setPreset(k) {
  if (!PRESETS[k]) return;
  S.eq = PRESETS[k].slice();
  S.preset = k;
  applyAll();
  syncUi();
  save();
}

function syncUi() {
  const on = !!S.on;
  if ($("hiToggle")) $("hiToggle").checked = on;
  const body = $("hiBody");
  if (body) body.classList.toggle("open", on);
  document.body.classList.toggle("hi-end", on);
  for (const [id, k] of [
    ["hiNorm", "norm"],
    ["hiLimit", "limit"],
    ["hi8d", "d8"],
    ["hiMeterToggle", "meter"],
    ["hiUltra", "ultra"],
  ])
    if ($(id)) $(id).checked = !!S[k];
  if ($("hiWidth")) {
    $("hiWidth").value = S.width;
    $("hiWidth").style.setProperty("--p", S.width / 2 + "%");
  }
  if ($("hiWidthVal")) $("hiWidthVal").textContent = S.width === 0 ? "Mono" : S.width + "%";
  S.eq.forEach((v, i) => {
    const r = $("hiEq" + i);
    if (r && +r.value !== v) r.value = v;
    if ($("hiEqV" + i)) $("hiEqV" + i).textContent = (v > 0 ? "+" : "") + v;
  });
  if ($("hiEqName")) $("hiEqName").textContent = PRESET_NAMES[S.preset] || "Custom";
  document.querySelectorAll("#hiPresets [data-p]").forEach((b) => b.classList.toggle("active", b.dataset.p === S.preset));
}

function set(k, v) {
  S[k] = v;
  save();
  if (k === "on") {
    if (v) build();
    wire();
    syncUltra();
    if (v && window.ui && window.ui.showToast && !G) window.ui.showToast("High End is on. It kicks in when you play a song", 3500);
  }
  if (k === "ultra") syncUltra();
  applyAll();
  syncMeter();
  syncUi();
}

function init() {
  eqUi();
  const bind = (id, k) => $(id) && $(id).addEventListener("change", (e) => set(k, e.target.checked));
  bind("hiToggle", "on");
  bind("hiNorm", "norm");
  bind("hiLimit", "limit");
  bind("hi8d", "d8");
  bind("hiMeterToggle", "meter");
  bind("hiUltra", "ultra");
  if ($("hiWidth"))
    $("hiWidth").addEventListener("input", (e) => {
      S.width = +e.target.value;
      applyAll();
      syncUi();
      save();
    });
  if ($("hiEqReset")) $("hiEqReset").addEventListener("click", () => setPreset("flat"));
  syncUi();
  // the sound engine only exists after the first play: build the chain as soon as it does
  const wait = setInterval(() => {
    if (window.audioSys && window.audioSys.ctx) {
      clearInterval(wait);
      build();
      syncMeter();
    }
  }, 400);
}

window.hiEnd = {
  get on() {
    return !!S.on;
  },
  get ultra() {
    return ultra();
  },
  set,
  setPreset,
  state: () => JSON.parse(JSON.stringify(S)),
  nodes: () => G,
  loud: () => ({ lufs: L.lufs, known: L.known, n: L.n, match: matchDb() }),
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
