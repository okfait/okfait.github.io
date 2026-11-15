// Liquid V2 (v2.14.0, default since v2.15.0): the V1 liquid shape, with the phonk-edit EFFECTS on top.
//
// What's on screen, back to front:
//  - the cover blown up soft behind everything, 2-tone in your theme color,
//    dark, and it moves with the "camera"
//  - the normal V1 liquid (same shape, same settings), with a soft bloom around it
//  - a ring of little teeth spinning around the cover (faster on bass) + shockwave rings on kicks
//  - the cover itself 2-tone with a shine sweeping across (CSS, see ui-v3.css body.lv2)
//  - camera: every KICK punches in (springy zoom that overshoots), zoom blur, red/blue split,
//    a little shake + tilt, and a slow drift the rest of the time so it never feels frozen
// Kicks: from the song's kick map (kick-map.js scans the whole song once = only real kick drums,
// not voices or notes). Until that scan is done, a live detector on the clean signal fills in.

const S = {
  w: 0, h: 0, D: 1,
  layer: null, lctx: null, glow: null, tint: null, vignette: null,
  bg: null, bgKey: "", bgImg: null, bgImgSrc: "",
  spring: { x: 0, v: 0 },
  R: { x: 0, v: 0 },
  shake: 0, tilt: 0,
  last: 0, t0: performance.now(),
  shocks: [],
  spin: 0,
  artScale: 1, artBlur: 0, artEl: null,
  lastFrame: 0,
  bodyOn: false,
  mapId: null, mapIdx: 0, mapPos: -1,
  an: null, fbuf: null, hist: [], fluxM: 1, fluxV: 1, lvl: -60, lastKick: 0, probeAt: 0,
  kickSeq: 0, kickStr: 0, usedSeq: 0,
  ext: false,
};

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
function setup(w, h, D) {
  S.w = w;
  S.h = h;
  S.D = D;
  S.layer = makeCanvas(w * D, h * D);
  S.lctx = S.layer.getContext("2d");
  S.glow = makeCanvas(w / 4, h / 4);
  S.tint = null;
  S.vignette = null;
  S.bgKey = "";
}

// ---------------------------------------------------------------- kicks
function fire(str) {
  S.kickSeq++;
  S.kickStr = str || 1;
}
function outLat() {
  const c = window.audioSys && window.audioSys.ctx;
  return c ? (c.outputLatency || 0) + (c.baseLatency || 0) : 0;
}
// kick map: fire when what you HEAR passes a kick (audio position minus the speaker delay,
// a hair early because the screen shows what we draw about one refresh later)
function probeMap(map) {
  const a = window.audioSys.audio;
  if (a.paused) {
    S.mapPos = -1;
    return;
  }
  const pos = a.currentTime - outLat() + 0.012;
  const t = map.t;
  if (S.mapId !== map.id || S.mapPos < 0 || pos < S.mapPos - 0.05 || pos > S.mapPos + 0.6) {
    // new song / seek / just pressed play: jump to the right spot without firing old kicks
    S.mapId = map.id;
    let lo = 0, hi = t.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (t[m] < pos - 0.02) lo = m + 1;
      else hi = m;
    }
    S.mapIdx = lo;
  }
  while (S.mapIdx < t.length && t[S.mapIdx] <= pos) {
    if (pos - t[S.mapIdx] < 0.15) fire(map.s[S.mapIdx]);
    S.mapIdx++;
  }
  S.mapPos = pos;
}

// live fallback (only while the song hasn't been scanned yet): zero-smoothing listener on the clean signal
function ensureAnalyser() {
  if (S.an || S.ext) return S.an;
  const as = window.audioSys;
  if (!as || !as.ctx || !as.src) return null;
  S.an = as.ctx.createAnalyser();
  S.an.fftSize = 2048;
  S.an.smoothingTimeConstant = 0;
  as.src.connect(S.an);
  S.fbuf = new Float32Array(S.an.frequencyBinCount);
  return S.an;
}
function probeLive(now) {
  const an = ensureAnalyser();
  if (!an) return;
  if (window.audioSys.audio.paused) {
    S.hist.length = 0;
    return;
  }
  an.getFloatFrequencyData(S.fbuf);
  const hz = an.context.sampleRate / an.fftSize;
  const lo = Math.max(1, Math.floor(20 / hz)), hi = Math.ceil(150 / hz);
  let p = 0;
  for (let i = lo; i <= hi; i++) p += Math.pow(10, S.fbuf[i] / 10);
  const L = 10 * Math.log10(p + 1e-12);
  S.hist.push({ t: now, L });
  while (S.hist.length && now - S.hist[0].t > 90) S.hist.shift();
  let mn = L;
  for (const e of S.hist) if (now - e.t <= 70) mn = Math.min(mn, e.L);
  const flux = Math.max(0, L - mn);
  S.lvl += (L - S.lvl) * 0.01;
  const thr = Math.max(3, S.fluxM + 2.2 * Math.sqrt(S.fluxV));
  const isKick = flux > thr && L > S.lvl - 9 && now - S.lastKick > 160;
  const d = flux - S.fluxM;
  S.fluxM += d * 0.02;
  S.fluxV += (d * d - S.fluxV) * 0.02;
  if (isKick) {
    S.lastKick = now;
    fire(Math.min(1.35, 0.6 + (flux - thr) / 8));
  }
}
function probe() {
  const now = performance.now();
  if (now - S.probeAt < 8) return;
  S.probeAt = now;
  if (S.ext) return; // phone remote: the PC tells us when
  const map = window.kickMap && window.kickMap.current();
  if (map) probeMap(map);
  else probeLive(now);
}
// phone remote: the PC says "kick!"
function kick(strength) {
  S.ext = true;
  fire(strength || 1);
}

function colors(viz) {
  const tMode = window.ui ? window.ui.themeMode : "solid";
  const acc = viz.accent();
  const t = performance.now() / 1000;
  if (tMode === "rainbow") {
    const h = (t * 50) % 360;
    return { line: `hsl(${h},100%,62%)` };
  }
  if (tMode === "gradient" && window.ui.themeGrad1) return { line: window.ui.themeGrad1 };
  if (tMode === "dominant" && window.dominantColor) return { line: window.dominantColor };
  return { line: acc };
}

// ---------------------------------------------------------------- 2-tone background from the cover
function coverSrc() {
  const t = window.player && window.player.currentTrack;
  return t && typeof t.art === "string" ? t.art : "";
}
// The background is the cover, blown up, soft and dark, in your theme color (like the edits):
//  - only the middle square of the cover is used (YouTube thumbnails have black bars baked in
//    on the sides - those showed up as dark stripes)
//  - shrunk to ~120 px first, then blown up with a blur = you see the cover's shapes moving
//    behind everything, but not a sharp photo; edges fade out in a soft circle (no hard borders)
//  - bright covers are dimmed and dark ones lifted, so every song glows about the same amount
// (Album Color Tint only changes the cover in the circle, not this.)
function buildBg(w, h, color) {
  const src = coverSrc();
  if (!src) {
    S.bg = null;
    S.bgKey = "none";
    return;
  }
  if (S.bgImgSrc !== src) {
    S.bgImgSrc = src;
    S.bgImg = new Image();
    S.bgImg.crossOrigin = "anonymous";
    S.bgImg.onload = () => (S.bgKey = ""); // rebuild once it's loaded
    S.bgImg.src = src;
    S.bg = null;
    S.bgKey = "loading";
    return;
  }
  const img = S.bgImg;
  if (!img || !img.complete || !img.naturalWidth) return;
  const tint = true; // background is always in your color
  // 1. tiny copy of the middle of the cover
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const side = Math.min(iw, ih);
  const tw = 120, th = 120;
  const tiny = makeCanvas(tw, th);
  const t = tiny.getContext("2d");
  // the whole middle square of the cover (not zoomed into a strip any more)
  t.drawImage(img, (iw - side) / 2, (ih - side) / 2, side, side, 0, 0, tw, th);
  if (tint) {
    // black -> your color: light parts of the cover glow in your color, dark parts stay dark
    if ("filter" in t) {
      const c2 = makeCanvas(tw, th);
      const g2 = c2.getContext("2d");
      g2.filter = "grayscale(1) contrast(1.4)";
      g2.drawImage(tiny, 0, 0);
      t.clearRect(0, 0, tw, th);
      t.drawImage(c2, 0, 0);
    }
    t.globalCompositeOperation = "multiply";
    t.fillStyle = color;
    t.fillRect(0, 0, tw, th);
    t.globalCompositeOperation = "source-over";
  }
  // 2. how bright is it? (so a white cover doesn't flood the screen)
  let lum = 0.3;
  try {
    const d = t.getImageData(0, 0, tw, th).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    lum = sum / (d.length / 4) / 255;
  } catch (e) {
    /* cover from another site: can't read it, use a safe guess */
  }
  S.bgGain = Math.max(0.5, Math.min(1.8, 0.2 / Math.max(0.04, lum)));
  // 3. blow it up with a big blur = color clouds
  const bw = Math.round(Math.min(480, w / 3)), bh = Math.max(8, Math.round((bw * h) / w));
  const c = makeCanvas(bw, bh);
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  // black first, so the space around the cover is dark (not the gray the "multiply" step below would leave)
  g.fillStyle = "#000";
  g.fillRect(0, 0, bw, bh);
  if ("filter" in g) g.filter = `blur(${Math.max(2, Math.round(bw / 70))}px) saturate(1.2)`;
  // v2.15.3: the WHOLE cover as a square in the middle, as tall as the screen (was 1.6x = way too zoomed in)
  const sq = Math.min(bw, bh) * 1.05;
  g.drawImage(tiny, (bw - sq) / 2, (bh - sq) / 2, sq, sq);
  if ("filter" in g) g.filter = "none";
  // dark like the edits: only the bright parts glow through
  g.globalCompositeOperation = "multiply";
  g.fillStyle = "rgb(150,150,150)";
  g.fillRect(0, 0, bw, bh);
  // soft round fade at the edges = melts into the dark, no square "picture stuck on" edges
  g.globalCompositeOperation = "destination-in";
  const fade = g.createRadialGradient(bw / 2, bh / 2, sq * 0.3, bw / 2, bh / 2, sq * 0.72); // wide enough to keep the corners
  fade.addColorStop(0, "rgba(0,0,0,1)");
  fade.addColorStop(0.6, "rgba(0,0,0,0.8)");
  fade.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = fade;
  g.fillRect(0, 0, bw, bh);
  g.globalCompositeOperation = "source-over";
  S.bg = c;
}

function frame(ctx, w, h, buf, viz) {
  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0.001, (now - (S.last || now - 16)) / 1000));
  S.last = now;
  S.lastFrame = now;
  const D = viz.dpr || 1;
  if (w !== S.w || h !== S.h || D !== S.D || !S.layer) setup(w, h, D);
  probe();
  if (!S.bodyOn) {
    S.bodyOn = true;
    document.body.classList.add("lv2");
  }

  const cfg = window.vizConfig || {};
  const sens = cfg.sens || window.vizSens || 1;
  const ac = viz.artCenter(w, h);
  const cx = ac.x, cy = ac.y;
  const sc = Math.max(0.6, Math.min(1.4, (ac.r || 120) / 120)) * (window.displayScale || 1);
  const base = (ac.r || 120) + 4 * sc;
  const paused = window.audioSys.audio.paused && !S.ext;
  const T = (now - S.t0) / 1000;

  let bass = 0, highs = 0;
  for (let i = 0; i < 6; i++) bass += buf[i];
  for (let i = 60; i < 200; i++) highs += buf[i];
  bass = Math.min(1, (bass / 6 / 255) * sens);
  highs = highs / 140 / 255;

  // ---------------------------------------------------------------- kicks
  if (S.kickSeq !== S.usedSeq) {
    S.usedSeq = S.kickSeq;
    // Settings > Visualizer > Beat Effects (on by default)
    if (!paused && (!window.vizOpts || window.vizOpts.beatFx)) {
      const k = S.kickStr;
      S.spring.v += 42 * k;
      S.shake = Math.min(1, S.shake + 0.5 * k);
      S.tilt = (Math.random() < 0.5 ? -1 : 1) * 0.035 * k;
      S.R.v += 160 * k;
      S.shocks.push({ r: base + 14 * sc, a: 0.6 * k });
      if (S.shocks.length > 3) S.shocks.shift();
    }
  }

  // ---------------------------------------------------------------- springs
  const sp = S.spring;
  sp.v += (-430 * sp.x - 20 * sp.v) * dt;
  sp.x += sp.v * dt;
  const punch = Math.max(-0.2, sp.x);
  const zoom = 1 + punch * 0.12;
  S.R.v += (-200 * S.R.x - 14 * S.R.v) * dt;
  S.R.x += S.R.v * dt;
  S.tilt *= Math.exp(-dt * 6);
  S.shake *= Math.exp(-dt * 9);
  S.spin += dt * (0.35 + bass * 1.6 + punch * 7);

  // ---------------------------------------------------------------- album art punches + blurs
  const blurAmt = Math.max(0, punch - 0.06);
  const art = S.artEl || (S.artEl = document.getElementById("artContainer"));
  const as = Math.round(zoom * 1000) / 1000;
  const ab = Math.round(blurAmt * 10) / 2;
  if (art && (as !== S.artScale || ab !== S.artBlur)) {
    art.style.transform = as !== 1 ? `scale(${as})` : "";
    art.style.filter = ab > 0 ? `blur(${ab}px)` : "";
    S.artScale = as;
    S.artBlur = ab;
  }

  const col = colors(viz);
  const hideShape = document.body.classList.contains("clean-lines-mode");

  // ---------------------------------------------------------------- background (camera moves it, a bit less than the front = depth)
  const key = coverSrc() + "|" + col.line + "|" + w + "x" + h;
  if (S.bgKey !== key && S.bgKey !== "loading") {
    buildBg(w, h, col.line);
    if (S.bgKey !== "loading") S.bgKey = key;
  }
  const sh = S.shake * S.shake;
  const sx = (Math.random() - 0.5) * 16 * sh * sc + Math.sin(T * 0.5) * 6 * sc;
  const sy = (Math.random() - 0.5) * 16 * sh * sc + Math.cos(T * 0.37) * 5 * sc;
  const rot = S.tilt + Math.sin(T * 0.23) * 0.01;
  if (S.bg) {
    // big enough that the tilt + shake never show an edge, even on a tall phone screen
    // (edges are faded out already, so no extra zoom needed to hide them)
    const z = 1 + punch * 0.05 + bass * 0.015;
    ctx.save();
    ctx.setTransform(D, 0, 0, D, 0, 0);
    ctx.translate(w / 2 + sx * 0.5, h / 2 + sy * 0.5);
    ctx.rotate(rot * 0.6);
    ctx.scale(z, z);
    ctx.globalAlpha = Math.min(0.75, (0.3 + bass * 0.12 + punch * 0.2) * (S.bgGain || 1));
    ctx.drawImage(S.bg, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
  // floating sparks (Settings > Visualizer > Particles), on top of the background
  if ((window.vizConfig || {}).sparks !== false && viz.drawSparks) {
    ctx.save();
    ctx.setTransform(D, 0, 0, D, 0, 0);
    viz.drawSparks(ctx, w, h, viz._avgVol || 0);
    ctx.restore();
  }

  // ---------------------------------------------------------------- front layer: the V1 liquid + V2 extras
  const L = S.lctx;
  L.setTransform(1, 0, 0, 1, 0, 0);
  L.globalAlpha = 1;
  L.globalCompositeOperation = "source-over";
  L.clearRect(0, 0, S.layer.width, S.layer.height);
  L.setTransform(D, 0, 0, D, 0, 0);

  for (let i = S.shocks.length - 1; i >= 0; i--) {
    const r = S.shocks[i];
    r.r += 650 * dt * sc;
    r.a -= 1.7 * dt;
    if (r.a <= 0) {
      S.shocks.splice(i, 1);
      continue;
    }
    L.globalAlpha = r.a * 0.5;
    L.strokeStyle = col.line;
    L.lineWidth = 1 + r.a * 3;
    L.beginPath();
    L.arc(cx, cy, r.r, 0, Math.PI * 2);
    L.stroke();
  }
  L.globalAlpha = 1;

  if (!hideShape) {
    // the normal V1 liquid, swelling a little on each kick
    const grow = 1 + Math.max(-0.03, S.R.x / 400);
    L.save();
    L.translate(cx, cy);
    L.scale(grow, grow);
    L.translate(-cx, -cy);
    viz.drawLiquid(L, w, h, buf);
    L.restore();
    L.globalCompositeOperation = "source-over";
    L.shadowBlur = 0;

    // soft bloom (tiny copy, blurred, added back on top = cheap glow)
    const g = S.glow.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, S.glow.width, S.glow.height);
    if ("filter" in g) g.filter = "blur(4px)";
    g.drawImage(S.layer, 0, 0, S.glow.width, S.glow.height);
    if ("filter" in g) g.filter = "none";
    L.save();
    L.setTransform(1, 0, 0, 1, 0, 0);
    L.globalCompositeOperation = "lighter";
    L.globalAlpha = Math.min(0.9, 0.3 + bass * 0.3 + Math.max(0, punch) * 0.4);
    L.drawImage(S.glow, 0, 0, S.layer.width, S.layer.height);
    L.restore();

    // spinning teeth right around the cover (the cover sits on top of the liquid's middle)
    const teeth = 44, tr = base;
    L.save();
    L.translate(cx, cy);
    L.rotate(S.spin);
    L.fillStyle = col.line;
    L.globalAlpha = 0.8 + highs * 0.2;
    L.beginPath();
    for (let i = 0; i < teeth; i++) {
      const a = (i / teeth) * Math.PI * 2;
      const len = (3 + (i % 2 ? 0 : 3) + highs * 8 + Math.max(0, punch) * 6) * sc;
      const wa = 0.03;
      L.moveTo(Math.cos(a - wa) * tr, Math.sin(a - wa) * tr);
      L.lineTo(Math.cos(a) * (tr + len), Math.sin(a) * (tr + len));
      L.lineTo(Math.cos(a + wa) * tr, Math.sin(a + wa) * tr);
    }
    L.fill();
    // thin counter-spinning dashed circle
    L.rotate(-S.spin * 1.7);
    L.globalAlpha = 0.6;
    L.strokeStyle = col.line;
    L.lineWidth = 1.3 * sc;
    L.setLineDash([12 * sc, 9 * sc]);
    L.beginPath();
    L.arc(0, 0, tr + 14 * sc, 0, Math.PI * 2);
    L.stroke();
    L.setLineDash([]);
    L.restore();
    L.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- camera: punch + zoom blur + shake/tilt/drift
  const put = (img, z, alpha, ox = 0) => {
    ctx.globalAlpha = alpha;
    ctx.setTransform(D, 0, 0, D, 0, 0);
    ctx.translate(cx + sx + ox, cy + sy);
    ctx.rotate(rot);
    ctx.scale(z, z);
    ctx.translate(-cx, -cy);
    ctx.drawImage(img, 0, 0, w, h);
  };
  ctx.save();
  if (punch > 0.2 && !hideShape) {
    // red / blue split on hard hits: the liquid copied twice, tinted, pushed apart
    if (!S.tint || S.tint.width !== S.layer.width || S.tint.height !== S.layer.height) S.tint = makeCanvas(S.layer.width, S.layer.height);
    const tc = S.tint.getContext("2d");
    const o = punch * 9 * sc;
    ctx.globalCompositeOperation = "lighter";
    for (const [c, dx] of [["rgb(255,40,90)", -o], ["rgb(40,170,255)", o]]) {
      tc.globalCompositeOperation = "source-over";
      tc.clearRect(0, 0, S.tint.width, S.tint.height);
      tc.drawImage(S.layer, 0, 0);
      tc.globalCompositeOperation = "source-in";
      tc.fillStyle = c;
      tc.fillRect(0, 0, S.tint.width, S.tint.height);
      put(S.tint, zoom, Math.min(0.55, punch * 0.6), dx);
    }
    ctx.globalCompositeOperation = "source-over";
  }
  put(S.layer, zoom, 1);
  if (blurAmt > 0.01) for (let k = 1; k <= 4; k++) put(S.layer, zoom * (1 + blurAmt * 0.05 * k), (0.3 * (5 - k)) / 4);
  ctx.restore();

  // flash on hard hits + dark edges
  if (punch > 0.35) {
    ctx.save();
    ctx.setTransform(D, 0, 0, D, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.min(0.18, (punch - 0.35) * 0.4);
    ctx.fillStyle = col.line;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
  if (!S.vignette) {
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.6);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.65)");
    S.vignette = vg;
  }
  ctx.save();
  ctx.setTransform(D, 0, 0, D, 0, 0);
  ctx.fillStyle = S.vignette;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function active() {
  if (window.__liquidVerOverride) return window.__liquidVerOverride === "v2";
  return (localStorage.getItem("okmusic_liquid_ver") || "v2") === "v2"; // V2 is the default since v2.15.0
}

function reset() {
  S.spring.x = S.spring.v = 0;
  S.R.x = S.R.v = 0;
  S.shake = S.tilt = 0;
  S.shocks.length = 0;
  const art = S.artEl || document.getElementById("artContainer");
  if (art) {
    art.style.transform = "";
    art.style.filter = "";
  }
  S.artScale = 1;
  S.artBlur = 0;
  if (S.bodyOn) {
    S.bodyOn = false;
    document.body.classList.remove("lv2");
  }
}

// if V2 stops being drawn (switched style, tab in background...), put the cover back to normal
setInterval(() => {
  if ((S.artScale !== 1 || S.artBlur || S.bodyOn) && performance.now() - S.lastFrame > 300) reset();
}, 500);

window.liquidV2 = { frame, active, reset, probe, kick, get kickSeq() { return S.kickSeq; }, get kickStr() { return S.kickStr; } };
