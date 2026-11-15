// Liquid V2 - "phonk edit" style visualizer.
//
// What those After Effects edits do, rebuilt live:
//  - the kick drum PUNCHES the whole picture: a very fast zoom-in that springs back with a
//    tiny overshoot (a damped spring, not a linear ease - that's the "motion graph" feel)
//  - zoom motion blur: every frame the last frames get pushed outward and fade, so things
//    leave radial streaks
//  - the liquid is drawn as a white-hot core with neon outlines that lag behind it
//  - shockwave rings + speed-line particles flying out of the ball on every hit
//  - a little camera shake and red/blue color split on the hardest hits
// Uses the same liquid shape + Liquid Tuner settings as V1. Pick it in Settings > Visualizer.

const S = {
  w: 0, h: 0,
  trailA: null, trailB: null, glow: null, vignette: null,
  spring: { x: 0, v: 0 },
  shake: 0,
  last: 0,
  lastKick: 0,
  prevBass: 0,
  bassMean: 0.3,
  shocks: [],
  parts: [],
  artScale: 1,
  artEl: null,
  lastFrame: 0,
};

const K = 420; // spring stiffness: how fast the punch snaps back
const C = 22; // spring damping: lower = more wobble after the hit

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function setup(w, h) {
  S.w = w;
  S.h = h;
  // the trail + glow run at lower resolution: they're blurry anyway, and it's 4-16x less work
  S.trailA = makeCanvas(w / 2, h / 2);
  S.trailB = makeCanvas(w / 2, h / 2);
  S.glow = makeCanvas(w / 4, h / 4);
  S.vignette = null;
}

function newPart(fromCenter) {
  return {
    ang: Math.random() * Math.PI * 2,
    dist: fromCenter ? 150 + Math.random() * 40 : 150 + Math.random() * 700,
    spd: 60 + Math.random() * 160,
    len: 10 + Math.random() * 30,
    w: Math.random() < 0.15 ? 2.2 : 1.1,
    a: 0.35 + Math.random() * 0.65,
  };
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

// Path of the liquid, scaled around the center (for the outline copies)
function strokeScaled(ctx, path, cx, cy, s) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.translate(-cx, -cy);
  ctx.stroke(path);
  ctx.restore();
}

function frame(ctx, w, h, buf, viz) {
  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0.001, (now - (S.last || now - 16)) / 1000));
  S.last = now;
  S.lastFrame = now;
  if (w !== S.w || h !== S.h || !S.trailA) setup(w, h);

  const cfg = window.vizConfig || {};
  const sens = cfg.sens || window.vizSens || 1;
  const ac = viz.artCenter(w, h);
  const cx = ac.x, cy = ac.y;

  // ---------------------------------------------------------------- listen
  let bass = 0, mids = 0, highs = 0;
  for (let i = 0; i < 6; i++) bass += buf[i];
  for (let i = 12; i < 48; i++) mids += buf[i];
  for (let i = 60; i < 220; i++) highs += buf[i];
  bass = Math.min(1, (bass / 6 / 255) * sens);
  mids = (mids / 36) / 255;
  highs = (highs / 160) / 255;
  const paused = window.audioSys.audio.paused;
  S.bassMean += (bass - S.bassMean) * 0.04;
  const rise = bass - S.prevBass;
  S.prevBass = bass;

  // kick = bass jumps up AND is clearly louder than the recent average
  const kick = !paused && bass > 0.42 && rise > 0.045 && bass > S.bassMean * 1.12 && now - S.lastKick > 150;
  if (kick) {
    S.lastKick = now;
    const strength = Math.min(1.4, 0.55 + (bass - S.bassMean) * 3);
    S.spring.v += 38 * strength;
    S.shake = Math.min(1, S.shake + 0.55 * strength);
    S.shocks.push({ r: 140, a: 0.9 * strength });
    if (S.shocks.length > 6) S.shocks.shift();
    // a burst of fresh particles right out of the ball
    for (let i = 0; i < 18; i++) S.parts.push(newPart(true));
  }

  // ---------------------------------------------------------------- spring (the punch curve)
  const acc = -K * S.spring.x - C * S.spring.v;
  S.spring.v += acc * dt;
  S.spring.x += S.spring.v * dt;
  const punch = Math.max(-0.25, S.spring.x); // ~0..1 right after a kick
  const zoom = 1 + punch * 0.075;
  S.shake *= Math.exp(-dt * 9);
  const shakeAmt = S.shake * S.shake;
  const sx = (Math.random() - 0.5) * 18 * shakeAmt;
  const sy = (Math.random() - 0.5) * 18 * shakeAmt;
  const rot = (Math.random() - 0.5) * 0.02 * shakeAmt;

  // the ball (album art) punches with the picture
  const art = S.artEl || (S.artEl = document.getElementById("artContainer"));
  const as = Math.round(zoom * 1000) / 1000;
  if (art && as !== S.artScale) {
    art.style.transform = `scale(${as})`;
    S.artScale = as;
  }

  const col = colors(viz);
  const hideShape = document.body.classList.contains("clean-lines-mode");
  const pts = viz.getSymmetricPoints(cx, cy, viz.history.getDelayedFrame(0));
  const core = viz.buildSmoothPath(pts);
  const lag1 = viz.buildSmoothPath(viz.getSymmetricPoints(cx, cy, viz.history.getDelayedFrame(4)));
  const lag2 = viz.buildSmoothPath(viz.getSymmetricPoints(cx, cy, viz.history.getDelayedFrame(9)));

  // ---------------------------------------------------------------- zoom-blur trail (half res)
  {
    const A = S.trailA, B = S.trailB;
    const bc = B.getContext("2d");
    const tw = B.width, th = B.height;
    bc.globalCompositeOperation = "copy";
    const grow = 1.018 + punch * 0.05 + bass * 0.01; // last frames get pushed outward = radial streaks
    const hx = cx / 2, hy = cy / 2;
    bc.globalAlpha = paused ? 0.7 : 0.8;
    bc.setTransform(grow, 0, 0, grow, hx - hx * grow, hy - hy * grow);
    bc.drawImage(A, 0, 0);
    bc.setTransform(1, 0, 0, 1, 0, 0);
    bc.globalAlpha = 1;
    bc.globalCompositeOperation = "lighter";
    if (!hideShape) {
      bc.save();
      bc.scale(0.5, 0.5);
      bc.lineWidth = 6;
      bc.strokeStyle = col.line;
      bc.globalAlpha = 0.45 + bass * 0.4;
      bc.stroke(core);
      bc.restore();
    }
    S.trailA = B;
    S.trailB = A;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.9;
    ctx.drawImage(S.trailA, 0, 0, w, h);
    ctx.restore();
  }

  // ---------------------------------------------------------------- particles (speed lines)
  if (cfg.sparks !== false) {
    const maxR = Math.hypot(w, h) * 0.6;
    while (S.parts.length < 140) S.parts.push(newPart(false));
    if (S.parts.length > 220) S.parts.splice(0, S.parts.length - 220);
    const boost = 1 + bass * 3 + punch * 9 + highs * 2;
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "#fff";
    for (let i = S.parts.length - 1; i >= 0; i--) {
      const p = S.parts[i];
      p.dist += p.spd * boost * dt;
      if (p.dist > maxR) {
        if (S.parts.length > 140) S.parts.splice(i, 1);
        else Object.assign(p, newPart(true));
        continue;
      }
      const L = p.len * (0.6 + boost * 0.7);
      const c = Math.cos(p.ang), s = Math.sin(p.ang);
      const fade = Math.min(1, (p.dist - 140) / 120) * p.a;
      if (fade <= 0.02) continue;
      ctx.globalAlpha = fade;
      ctx.lineWidth = p.w;
      ctx.beginPath();
      ctx.moveTo(cx + c * p.dist, cy + s * p.dist);
      ctx.lineTo(cx + c * Math.max(140, p.dist - L), cy + s * Math.max(140, p.dist - L));
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- camera
  ctx.save();
  ctx.translate(cx + sx, cy + sy);
  ctx.scale(zoom, zoom);
  ctx.rotate(rot);
  ctx.translate(-cx, -cy);

  // shockwave rings
  for (let i = S.shocks.length - 1; i >= 0; i--) {
    const r = S.shocks[i];
    r.r += 900 * dt;
    r.a -= 1.5 * dt;
    if (r.a <= 0) {
      S.shocks.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = r.a * 0.8;
    ctx.strokeStyle = col.line;
    ctx.lineWidth = 2 + r.a * 5;
    ctx.beginPath();
    ctx.arc(cx, cy, r.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  if (!hideShape) {
    // soft glow: drawn tiny and blurred, then stretched up = cheap big bloom
    const g = S.glow.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, S.glow.width, S.glow.height);
    g.scale(0.25, 0.25);
    if ("filter" in g) g.filter = "blur(5px)";
    g.fillStyle = col.rim;
    g.globalAlpha = 0.55 + bass * 0.45;
    g.fill(core);
    g.lineWidth = 30;
    g.strokeStyle = col.line;
    g.stroke(lag1);
    if ("filter" in g) g.filter = "none";
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(S.glow, 0, 0, w, h);
    ctx.restore();

    // neon outlines that lag behind the core (the "flow")
    ctx.lineJoin = "round";
    ctx.strokeStyle = col.line2;
    ctx.globalAlpha = 0.35 + mids * 0.4;
    ctx.lineWidth = 2;
    strokeScaled(ctx, lag2, cx, cy, 1.1 + bass * 0.04);
    ctx.strokeStyle = col.line;
    ctx.globalAlpha = 0.7 + mids * 0.3;
    ctx.lineWidth = 3 + bass * 3;
    strokeScaled(ctx, lag1, cx, cy, 1.045 + bass * 0.02);
    ctx.globalAlpha = 1;

    // red / blue split on hard hits
    if (punch > 0.18) {
      const o = punch * 9;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = Math.min(0.6, punch * 0.7);
      ctx.translate(-o, 0);
      ctx.fillStyle = "rgb(255,30,90)";
      ctx.fill(core);
      ctx.translate(o * 2, 0);
      ctx.fillStyle = "rgb(30,170,255)";
      ctx.fill(core);
      ctx.restore();
    }

    // white-hot core with a colored rim
    const rg = ctx.createRadialGradient(cx, cy, 120, cx, cy, 320);
    rg.addColorStop(0, "#ffffff");
    rg.addColorStop(0.45, "#ffffff");
    rg.addColorStop(1, col.rim);
    ctx.fillStyle = col.ring && window.artRing ? viz.artConic(ctx, cx, cy) : rg;
    ctx.fill(core);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.stroke(core);
  }
  ctx.restore();

  // ---------------------------------------------------------------- vignette (darker edges)
  if (!S.vignette) {
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.55)");
    S.vignette = vg;
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = S.vignette;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function active() {
  return (localStorage.getItem("okmusic_liquid_ver") || "v1") === "v2";
}

function reset() {
  S.spring.x = S.spring.v = 0;
  S.shake = 0;
  S.shocks.length = 0;
  if (S.trailA) S.trailA.getContext("2d").clearRect(0, 0, S.trailA.width, S.trailA.height);
  const art = S.artEl || document.getElementById("artContainer");
  if (art) art.style.transform = "";
  S.artScale = 1;
}

// if V2 stops being drawn (switched to V1, ring, bars...), put the album art back to normal size
setInterval(() => {
  if (S.artScale !== 1 && performance.now() - S.lastFrame > 300) reset();
}, 500);

window.liquidV2 = { frame, active, reset };
