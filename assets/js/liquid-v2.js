// Liquid V2 - phonk edit style (v2.13.2 rebuild, modeled on the YouTube Shorts phonk visualizers).
//
// What's on screen, back to front:
//  - the album art blown up as the background, turned 2-tone (black -> your color -> white),
//    dark, and it moves with the "camera"
//  - thin glowing liquid OUTLINES (no filled white blob any more = no raindrop), several
//    layers that lag behind each other, with sharp spikes on both sides (mirrored 4 ways)
//  - a black disc behind the cover + a ring of little teeth spinning around it (faster on bass)
//  - the cover itself 2-tone with a shine sweeping across (CSS, see ui-v3.css body.lv2)
//  - camera: every kick punches in (springy zoom that overshoots), zoom blur, a little shake + tilt,
//    and a slow drift the rest of the time so it never feels frozen
// Kicks come from a separate zero-smoothing listener on the clean signal (catches way more
// than reading the boosted, smoothed visualizer numbers).

const S = {
  w: 0, h: 0,
  layer: null, lctx: null, glow: null, vignette: null,
  bg: null, bgKey: "", bgImg: null, bgImgSrc: "",
  spring: { x: 0, v: 0 },
  shake: 0, tilt: 0,
  last: 0, t0: performance.now(),
  shocks: [],
  spin: 0,
  artScale: 1, artBlur: 0, artEl: null,
  lastFrame: 0,
  bodyOn: false,
  n: 96,
  x: null, v: null, ex: null, ev: null, ex2: null, ev2: null,
  R: { x: 0, v: 0 },
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
function setup(w, h) {
  S.w = w;
  S.h = h;
  S.layer = makeCanvas(w, h);
  S.lctx = S.layer.getContext("2d");
  S.glow = makeCanvas(w / 4, h / 4);
  S.vignette = null;
  S.bgKey = "";
}
function ring() {
  if (S.x) return;
  for (const k of ["x", "v", "ex", "ev", "ex2", "ev2"]) S[k] = new Float32Array(S.n);
}

// ---------------------------------------------------------------- kick detector
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
function probe() {
  const now = performance.now();
  if (now - S.probeAt < 8) return;
  S.probeAt = now;
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
    S.kickSeq++;
    S.kickStr = Math.min(1.35, 0.6 + (flux - thr) / 8);
  }
}
function kick(strength) {
  S.ext = true;
  S.kickSeq++;
  S.kickStr = strength || 1;
}

function colors(viz) {
  const tMode = window.ui ? window.ui.themeMode : "solid";
  const acc = viz.accent();
  const t = performance.now() / 1000;
  if (tMode === "rainbow") {
    const h = (t * 50) % 360;
    return { line: `hsl(${h},100%,62%)`, line2: `hsl(${(h + 60) % 360},100%,62%)` };
  }
  if (tMode === "gradient" && window.ui.themeGrad1) return { line: window.ui.themeGrad1, line2: window.ui.themeGrad2 };
  if (tMode === "dominant" && window.dominantColor) return { line: window.dominantColor, line2: window.dominantColor2 || acc };
  return { line: acc, line2: acc };
}

// ---------------------------------------------------------------- 2-tone background from the cover
function coverSrc() {
  const t = window.player && window.player.currentTrack;
  return t && typeof t.art === "string" ? t.art : "";
}
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
  // small on purpose: it's dark + soft, and it gets stretched (cheap to draw every frame)
  const bw = Math.round(Math.min(640, w / 2)), bh = Math.round((bw * h) / w);
  const c = makeCanvas(bw, bh);
  const g = c.getContext("2d");
  const sc = Math.max(bw / img.naturalWidth, bh / img.naturalHeight) * 1.15;
  const iw = img.naturalWidth * sc, ih = img.naturalHeight * sc;
  if ("filter" in g) g.filter = "grayscale(1) contrast(1.7) brightness(0.5) blur(1.5px)";
  g.drawImage(img, (bw - iw) / 2, (bh - ih) / 2, iw, ih);
  if ("filter" in g) g.filter = "none";
  // black -> color -> white: keep the light/dark, paint everything in your color
  g.globalCompositeOperation = "color";
  g.fillStyle = color;
  g.fillRect(0, 0, bw, bh);
  // dark like the edits: only the bright parts of the cover glow through
  g.globalCompositeOperation = "multiply";
  g.fillStyle = "rgb(120,120,120)";
  g.fillRect(0, 0, bw, bh);
  g.globalCompositeOperation = "source-over";
  S.bg = c;
}

// smooth closed outline through the ring points (arr = how far out each point is)
function blobPath(cx, cy, base, arr, scale) {
  const n = S.n;
  const px = new Array(n), py = new Array(n);
  for (let i = 0; i < n; i++) {
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const r = (base + arr[i]) * scale;
    px[i] = cx + Math.cos(ang) * r;
    py[i] = cy + Math.sin(ang) * r;
  }
  const p = new Path2D();
  p.moveTo((px[n - 1] + px[0]) / 2, (py[n - 1] + py[0]) / 2);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    p.quadraticCurveTo(px[i], py[i], (px[i] + px[j]) / 2, (py[i] + py[j]) / 2);
  }
  p.closePath();
  return p;
}

function frame(ctx, w, h, buf, viz) {
  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0.001, (now - (S.last || now - 16)) / 1000));
  S.last = now;
  S.lastFrame = now;
  if (w !== S.w || h !== S.h || !S.layer) setup(w, h);
  ring();
  probe();
  if (!S.bodyOn) {
    S.bodyOn = true;
    document.body.classList.add("lv2");
  }

  const cfg = window.vizConfig || {};
  const sens = cfg.sens || window.vizSens || 1;
  const ac = viz.artCenter(w, h);
  const cx = ac.x, cy = ac.y;
  const sc = window.displayScale || 1;
  const base = (ac.r || 120) + 10 * sc;
  const paused = window.audioSys.audio.paused && !S.ext;
  const T = (now - S.t0) / 1000;

  let bass = 0, mids = 0, highs = 0;
  for (let i = 0; i < 6; i++) bass += buf[i];
  for (let i = 12; i < 48; i++) mids += buf[i];
  for (let i = 60; i < 200; i++) highs += buf[i];
  bass = Math.min(1, (bass / 6 / 255) * sens);
  mids = mids / 36 / 255;
  highs = highs / 140 / 255;

  // ---------------------------------------------------------------- kicks
  if (S.kickSeq !== S.usedSeq) {
    S.usedSeq = S.kickSeq;
    if (!paused) {
      const k = S.kickStr;
      S.spring.v += 42 * k;
      S.shake = Math.min(1, S.shake + 0.5 * k);
      S.tilt = (Math.random() < 0.5 ? -1 : 1) * 0.035 * k;
      S.R.v += 300 * k * sc;
      for (let i = 0; i < S.n; i++) S.v[i] += 380 * k * sc * (0.6 + 0.4 * Math.random());
      S.shocks.push({ r: base, a: 0.6 * k });
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

  // the outline: 4-way mirrored (balanced, spiky on both sides), bass at the sides, highs top/bottom
  const n = S.n, q = n / 4;
  const amp = 120 * sc * sens;
  const steps = 2, h2 = dt / steps;
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < n; i++) {
      const m = i % (2 * q);
      const f = 1 - Math.abs(m - q) / q; // 1 at the sides (3 & 9 o'clock), 0 at top/bottom
      const bin = Math.floor(2 + Math.pow(1 - f, 1.5) * 150);
      let lv = (buf[bin] + buf[bin + 1]) / 510;
      lv = Math.max(0, lv - 0.2) / 0.8;
      // sharp spikes: high power curve, extra reach for the bass horns
      const target = paused ? 0 : Math.pow(lv, 2.4) * amp * (0.45 + f * 0.75);
      const l = S.x[(i - 1 + n) % n], r = S.x[(i + 1) % n];
      const acc = 520 * (target - S.x[i]) + 380 * (l + r - 2 * S.x[i]) - 16 * S.v[i];
      S.v[i] += acc * h2;
    }
    for (let i = 0; i < n; i++) {
      S.x[i] += S.v[i] * h2;
      if (S.x[i] < -8 * sc) {
        S.x[i] = -8 * sc;
        S.v[i] *= -0.3;
      }
      S.ev[i] += (90 * (S.x[i] - S.ex[i]) - 9 * S.ev[i]) * h2; // 1st echo
      S.ex[i] += S.ev[i] * h2;
      S.ev2[i] += (35 * (S.ex[i] - S.ex2[i]) - 6 * S.ev2[i]) * h2; // 2nd, lazier echo
      S.ex2[i] += S.ev2[i] * h2;
    }
  }

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
    const z = 1.08 + punch * 0.07 + bass * 0.02;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(w / 2 + sx * 0.5, h / 2 + sy * 0.5);
    ctx.rotate(rot * 0.6);
    ctx.scale(z, z);
    ctx.globalAlpha = Math.min(0.6, 0.28 + bass * 0.12 + punch * 0.2);
    ctx.drawImage(S.bg, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  // ---------------------------------------------------------------- front layer
  const L = S.lctx;
  L.setTransform(1, 0, 0, 1, 0, 0);
  L.clearRect(0, 0, w, h);
  const baseR = base + S.R.x;
  const core = blobPath(cx, cy, baseR, S.x, 1);
  const e1 = blobPath(cx, cy, baseR, S.ex, 1.04);
  const e2 = blobPath(cx, cy, baseR, S.ex2, 1.09 + bass * 0.03);

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
    // glow (tiny + blurred + stretched = cheap bloom)
    const g = S.glow.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, S.glow.width, S.glow.height);
    g.scale(0.25, 0.25);
    if ("filter" in g) g.filter = "blur(5px)";
    g.strokeStyle = col.line;
    g.globalAlpha = 0.7 + bass * 0.3;
    g.lineWidth = 26;
    g.stroke(core);
    g.lineWidth = 16;
    g.stroke(e2);
    if ("filter" in g) g.filter = "none";
    L.save();
    L.globalCompositeOperation = "lighter";
    L.drawImage(S.glow, 0, 0, w, h);
    L.restore();

    // the black disc inside (the cover sits on it)
    L.fillStyle = "rgba(0,0,0,0.88)";
    L.fill(core);

    // spinning teeth around the disc
    const teeth = 40, tr = base - 4 * sc;
    L.save();
    L.translate(cx, cy);
    L.rotate(S.spin);
    L.fillStyle = col.line;
    L.globalAlpha = 0.55 + highs * 0.8;
    L.beginPath();
    for (let i = 0; i < teeth; i++) {
      const a = (i / teeth) * Math.PI * 2;
      const len = (5 + (i % 2 ? 0 : 4) + highs * 10) * sc;
      const wa = 0.035;
      L.moveTo(Math.cos(a - wa) * tr, Math.sin(a - wa) * tr);
      L.lineTo(Math.cos(a) * (tr + len), Math.sin(a) * (tr + len));
      L.lineTo(Math.cos(a + wa) * tr, Math.sin(a + wa) * tr);
    }
    L.fill();
    // thin counter-spinning dashed circle
    L.rotate(-S.spin * 1.7);
    L.globalAlpha = 0.5;
    L.strokeStyle = "#fff";
    L.lineWidth = 1.2 * sc;
    L.setLineDash([14 * sc, 10 * sc]);
    L.beginPath();
    L.arc(0, 0, tr - 6 * sc, 0, Math.PI * 2);
    L.stroke();
    L.setLineDash([]);
    L.restore();

    // the layered outlines: lazy echo (color, faint) -> echo (color) -> core (white-hot, thin)
    L.lineJoin = "round";
    L.strokeStyle = col.line2;
    L.globalAlpha = 0.35 + mids * 0.4;
    L.lineWidth = 1.5 * sc;
    L.stroke(e2);
    L.strokeStyle = col.line;
    L.globalAlpha = 0.85;
    L.lineWidth = (2.5 + bass * 2.5) * sc;
    L.stroke(e1);
    if (punch > 0.2) {
      // red / blue split on hard hits
      const o = punch * 8 * sc;
      L.save();
      L.globalCompositeOperation = "lighter";
      L.globalAlpha = Math.min(0.6, punch * 0.6);
      L.lineWidth = 2 * sc;
      L.translate(-o, 0);
      L.strokeStyle = "rgb(255,40,90)";
      L.stroke(core);
      L.translate(o * 2, 0);
      L.strokeStyle = "rgb(40,170,255)";
      L.stroke(core);
      L.restore();
    }
    L.globalAlpha = 1;
    L.strokeStyle = "#fff";
    L.lineWidth = 2 * sc;
    L.shadowColor = col.line;
    L.shadowBlur = 12;
    L.stroke(core);
    L.shadowBlur = 0;
  }

  // ---------------------------------------------------------------- camera: punch + zoom blur + shake/tilt/drift
  const put = (z, alpha) => {
    ctx.globalAlpha = alpha;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(cx + sx, cy + sy);
    ctx.rotate(rot);
    ctx.scale(z, z);
    ctx.translate(-cx, -cy);
    ctx.drawImage(S.layer, 0, 0);
  };
  ctx.save();
  put(zoom, 1);
  if (blurAmt > 0.01) for (let k = 1; k <= 4; k++) put(zoom * (1 + blurAmt * 0.05 * k), (0.3 * (5 - k)) / 4);
  ctx.restore();

  // flash on hard hits + dark edges
  if (punch > 0.35) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = S.vignette;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function active() {
  if (window.__liquidVerOverride) return window.__liquidVerOverride === "v2";
  return (localStorage.getItem("okmusic_liquid_ver") || "v1") === "v2";
}

function reset() {
  S.spring.x = S.spring.v = 0;
  S.R.x = S.R.v = 0;
  S.shake = S.tilt = 0;
  S.shocks.length = 0;
  if (S.x) for (const k of ["x", "v", "ex", "ev", "ex2", "ev2"]) S[k].fill(0);
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
