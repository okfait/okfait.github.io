// Liquid V2 - edit style visualizer (v2.13 rework).
//
// What changed from the first V2 and why:
//  - the flying "speed lines" + the radial smear trail are gone (they made people dizzy)
//  - kick detection used to read the same smoothed + boosted numbers as the drawing, and with
//    heavy bass those numbers sit at the maximum all the time, so most kicks got missed.
//    Now it has its OWN listener on the clean signal with zero smoothing, and it looks for a
//    sudden jump in low-end loudness compared to the last ~1 second. Catches way more kicks.
//  - every kick = the whole picture punches in (springy zoom that overshoots a bit) with a
//    zoom blur, and the album art blurs with it for a split second
//  - the liquid itself is a ring of little springs that pull on their neighbours, so a hit
//    sends real waves around it and it wobbles after, instead of just following the bars
// Shares the Liquid Tuner "Height (sensitivity)" with V1.

const S = {
  w: 0, h: 0,
  layer: null, lctx: null, glow: null, vignette: null,
  spring: { x: 0, v: 0 },
  shake: 0,
  last: 0,
  shocks: [],
  artScale: 1, artBlur: 0, artEl: null,
  lastFrame: 0,
  // the liquid ring
  n: 72,
  x: null, v: null, // fast springs (the surface)
  ex: null, ev: null, // slow springs (the echo outline)
  R: { x: 0, v: 0 }, // whole-ring inflate
  // kick detector
  an: null, fbuf: null, hist: [], fluxM: 1, fluxV: 1, lvl: -60, lastKick: 0, probeAt: 0,
  kickSeq: 0, kickStr: 0, usedSeq: 0,
  ext: false, // true on the phone remote: kicks come from the PC
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
}
function ring() {
  if (S.x) return;
  S.x = new Float32Array(S.n);
  S.v = new Float32Array(S.n);
  S.ex = new Float32Array(S.n);
  S.ev = new Float32Array(S.n);
}

// ---------------------------------------------------------------- kick detector
function ensureAnalyser() {
  if (S.an || S.ext) return S.an;
  const as = window.audioSys;
  if (!as || !as.ctx || !as.src) return null;
  S.an = as.ctx.createAnalyser();
  S.an.fftSize = 2048;
  S.an.smoothingTimeConstant = 0; // raw: smoothing smears the punch of a kick
  as.src.connect(S.an);
  S.fbuf = new Float32Array(S.an.frequencyBinCount);
  return S.an;
}
// Runs the detector at most once per ~8ms, whoever calls it (drawing or the phone remote sender)
function probe() {
  const now = performance.now();
  if (now - S.probeAt < 8) return;
  S.probeAt = now;
  const an = ensureAnalyser();
  if (!an) return;
  const a = window.audioSys.audio;
  if (a.paused) {
    S.hist.length = 0;
    return;
  }
  an.getFloatFrequencyData(S.fbuf);
  // ~20-150 Hz, summed as real loudness
  const hz = an.context.sampleRate / an.fftSize;
  const lo = Math.max(1, Math.floor(20 / hz)), hi = Math.ceil(150 / hz);
  let p = 0;
  for (let i = lo; i <= hi; i++) p += Math.pow(10, S.fbuf[i] / 10);
  const L = 10 * Math.log10(p + 1e-12);
  S.hist.push({ t: now, L });
  while (S.hist.length && now - S.hist[0].t > 90) S.hist.shift();
  // how much louder than the quietest moment in the last ~70ms (= the hit's attack)
  let mn = L;
  for (const e of S.hist) if (now - e.t <= 70) mn = Math.min(mn, e.L);
  const flux = Math.max(0, L - mn);
  S.lvl += (L - S.lvl) * 0.01;
  const thr = Math.max(3, S.fluxM + 2.2 * Math.sqrt(S.fluxV));
  const isKick = flux > thr && L > S.lvl - 9 && now - S.lastKick > 160;
  // running average + spread of the jumps (so loud and quiet songs both work)
  const d = flux - S.fluxM;
  S.fluxM += d * 0.02;
  S.fluxV += (d * d - S.fluxV) * 0.02;
  if (isKick) {
    S.lastKick = now;
    S.kickSeq++;
    S.kickStr = Math.min(1.35, 0.6 + (flux - thr) / 8);
  }
}
// phone remote: the PC tells us when it heard a kick
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
    return { line: `hsl(${h},100%,62%)`, line2: `hsl(${(h + 60) % 360},100%,62%)`, rim: `hsl(${h},100%,70%)` };
  }
  if (tMode === "gradient" && window.ui.themeGrad1) return { line: window.ui.themeGrad1, line2: window.ui.themeGrad2, rim: window.ui.themeGrad2 };
  if (tMode === "dominant" && window.dominantColor) return { line: window.dominantColor, line2: window.dominantColor2 || acc, rim: window.dominantColor, ring: true };
  return { line: acc, line2: acc, rim: acc };
}

// smooth closed blob through the ring points
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

  const cfg = window.vizConfig || {};
  const sens = cfg.sens || window.vizSens || 1;
  const ac = viz.artCenter(w, h);
  const cx = ac.x, cy = ac.y;
  const sc = window.displayScale || 1;
  const base = (ac.r || 140) + 6;
  const paused = window.audioSys.audio.paused;

  // ---------------------------------------------------------------- listen (shape)
  let bass = 0, mids = 0;
  for (let i = 0; i < 6; i++) bass += buf[i];
  for (let i = 12; i < 48; i++) mids += buf[i];
  bass = Math.min(1, (bass / 6 / 255) * sens);
  mids = mids / 36 / 255;

  // ---------------------------------------------------------------- kicks
  if (S.kickSeq !== S.usedSeq) {
    S.usedSeq = S.kickSeq;
    if (!paused || S.ext) {
      const k = S.kickStr;
      S.spring.v += 40 * k;
      S.shake = Math.min(1, S.shake + 0.45 * k);
      S.R.v += 520 * k * sc;
      // splash: the top + bottom of the liquid get kicked outward, waves run around from there
      for (let i = 0; i < S.n; i++) {
        const ang = (i / S.n) * Math.PI * 2;
        S.v[i] += (260 + 200 * Math.abs(Math.cos(ang))) * k * sc;
      }
      S.shocks.push({ r: base, a: 0.75 * k });
      if (S.shocks.length > 4) S.shocks.shift();
    }
  }

  // ---------------------------------------------------------------- springs
  const sp = S.spring;
  sp.v += (-420 * sp.x - 21 * sp.v) * dt;
  sp.x += sp.v * dt;
  const punch = Math.max(-0.2, sp.x); // ~0..1 right after a kick
  const zoom = 1 + punch * 0.11;
  S.R.v += (-180 * S.R.x - 12 * S.R.v) * dt;
  S.R.x += S.R.v * dt;

  // the ring: each point chases its frequency, pulls on its neighbours, and overshoots
  const n = S.n, half = n / 2;
  const amp = 115 * sc * sens;
  const steps = 2, h2 = dt / steps;
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < n; i++) {
      // mirror left/right; top = deep bass, bottom = highs
      const m = i <= half ? i : n - i;
      const f = m / half;
      const bin = Math.floor(2 + Math.pow(f, 1.6) * 180);
      let lv = (buf[bin] + buf[bin + 1]) / 510;
      lv = Math.max(0, lv - 0.18) / 0.82;
      const target = paused && !S.ext ? 0 : Math.pow(lv, 1.7) * amp * (1.15 - f * 0.45);
      const l = S.x[(i - 1 + n) % n], r = S.x[(i + 1) % n];
      const acc = 300 * (target - S.x[i]) + 900 * (l + r - 2 * S.x[i]) - 13 * S.v[i];
      S.v[i] += acc * h2;
    }
    for (let i = 0; i < n; i++) {
      S.x[i] += S.v[i] * h2;
      if (S.x[i] < -20 * sc) {
        S.x[i] = -20 * sc;
        S.v[i] *= -0.3;
      }
      // the echo outline follows lazily
      S.ev[i] += (60 * (S.x[i] - S.ex[i]) - 7 * S.ev[i]) * h2;
      S.ex[i] += S.ev[i] * h2;
    }
  }

  // ---------------------------------------------------------------- album art punches + blurs
  S.shake *= Math.exp(-dt * 9);
  const blurAmt = Math.max(0, punch - 0.06);
  const art = S.artEl || (S.artEl = document.getElementById("artContainer"));
  const as = Math.round(zoom * 1000) / 1000;
  const ab = Math.round(blurAmt * 10) / 2; // px, steps of .5
  if (art && (as !== S.artScale || ab !== S.artBlur)) {
    art.style.transform = as !== 1 ? `scale(${as})` : "";
    art.style.filter = ab > 0 ? `blur(${ab}px)` : "";
    S.artScale = as;
    S.artBlur = ab;
  }

  // ---------------------------------------------------------------- draw into the layer
  const L = S.lctx;
  L.setTransform(1, 0, 0, 1, 0, 0);
  L.clearRect(0, 0, w, h);
  const col = colors(viz);
  const hideShape = document.body.classList.contains("clean-lines-mode");
  const baseR = base + S.R.x;
  const core = blobPath(cx, cy, baseR, S.x, 1);

  // shockwave rings (one soft ring per kick)
  for (let i = S.shocks.length - 1; i >= 0; i--) {
    const r = S.shocks[i];
    r.r += 700 * dt * sc;
    r.a -= 1.6 * dt;
    if (r.a <= 0) {
      S.shocks.splice(i, 1);
      continue;
    }
    L.globalAlpha = r.a * 0.6;
    L.strokeStyle = col.line;
    L.lineWidth = 1.5 + r.a * 4;
    L.beginPath();
    L.arc(cx, cy, r.r, 0, Math.PI * 2);
    L.stroke();
  }
  L.globalAlpha = 1;

  if (!hideShape) {
    const echo = blobPath(cx, cy, baseR, S.ex, 1.07 + bass * 0.03);
    // soft glow: drawn tiny and blurred, then stretched up = cheap big bloom
    const g = S.glow.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, S.glow.width, S.glow.height);
    g.scale(0.25, 0.25);
    if ("filter" in g) g.filter = "blur(6px)";
    g.fillStyle = col.rim;
    g.globalAlpha = 0.5 + bass * 0.5;
    g.fill(core);
    g.lineWidth = 34;
    g.strokeStyle = col.line;
    g.stroke(echo);
    if ("filter" in g) g.filter = "none";
    L.save();
    L.globalCompositeOperation = "lighter";
    L.drawImage(S.glow, 0, 0, w, h);
    L.restore();

    // the echo outline (lags behind = the flowing look)
    L.lineJoin = "round";
    L.strokeStyle = col.line2;
    L.globalAlpha = 0.45 + mids * 0.45;
    L.lineWidth = 2.5 + bass * 2;
    L.stroke(echo);
    L.globalAlpha = 1;

    // red / blue split on hard hits
    if (punch > 0.2) {
      const o = punch * 10 * sc;
      L.save();
      L.globalCompositeOperation = "lighter";
      L.globalAlpha = Math.min(0.55, punch * 0.6);
      L.translate(-o, 0);
      L.fillStyle = "rgb(255,30,90)";
      L.fill(core);
      L.translate(o * 2, 0);
      L.fillStyle = "rgb(30,170,255)";
      L.fill(core);
      L.restore();
    }

    // white-hot core with a colored rim
    const rg = L.createRadialGradient(cx, cy, baseR * 0.85, cx, cy, baseR + amp);
    rg.addColorStop(0, "#ffffff");
    rg.addColorStop(0.35, "#ffffff");
    rg.addColorStop(1, col.rim);
    L.fillStyle = col.ring && window.artRing ? viz.artConic(L, cx, cy) : rg;
    L.fill(core);
    L.lineWidth = 1.5;
    L.strokeStyle = "rgba(255,255,255,0.9)";
    L.stroke(core);
  }

  // ---------------------------------------------------------------- camera: punch zoom + zoom blur
  const sh = S.shake * S.shake;
  const sx = (Math.random() - 0.5) * 14 * sh * sc;
  const sy = (Math.random() - 0.5) * 14 * sh * sc;
  const put = (z, alpha) => {
    ctx.globalAlpha = alpha;
    ctx.setTransform(z, 0, 0, z, cx - cx * z + sx, cy - cy * z + sy);
    ctx.drawImage(S.layer, 0, 0);
  };
  ctx.save();
  put(zoom, 1);
  if (blurAmt > 0.01) {
    // a few bigger, fainter copies = the "zoom blur" streak, only during the punch
    for (let k = 1; k <= 4; k++) put(zoom * (1 + blurAmt * 0.05 * k), (0.32 * (5 - k)) / 4);
  }
  ctx.restore();

  // ---------------------------------------------------------------- vignette (darker edges)
  if (!S.vignette) {
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.5)");
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
  S.shake = 0;
  S.shocks.length = 0;
  if (S.x) {
    S.x.fill(0);
    S.v.fill(0);
    S.ex.fill(0);
    S.ev.fill(0);
  }
  const art = S.artEl || document.getElementById("artContainer");
  if (art) {
    art.style.transform = "";
    art.style.filter = "";
  }
  S.artScale = 1;
  S.artBlur = 0;
}

// if V2 stops being drawn (switched to V1, ring, bars, tab in background...), put the album art back
setInterval(() => {
  if ((S.artScale !== 1 || S.artBlur) && performance.now() - S.lastFrame > 300) reset();
}, 500);

window.liquidV2 = { frame, active, reset, probe, kick, get kickSeq() { return S.kickSeq; }, get kickStr() { return S.kickStr; } };
