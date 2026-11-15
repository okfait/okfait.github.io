// okMUSIC first-visit tutorial ("PT" = pulsating tutorial).
// Almost no text: a spotlight glides to the thing you should press (everything else goes dark),
// rings ripple out of it and a little finger taps on it.
//   1. Library button ("Library")   2. Add Songs   3. the helper downloads (each one ticks off)
//   4. "Start okMUSIC Helper.bat" + come back   5. Search / Playlist tabs once the helper connects
// Shows once. "skip" in the corner ends it. Phones stop after step 2 (the helper is PC-only).
// Run it again any time: window.tutorial.start()
// v2.15.0: smooth gliding spotlight, ripples, tapping finger, step dots, pop-in labels, finish burst.

const KEY = "okmusic_tut_done";
const $ = (id) => document.getElementById(id);
const isPhone = () => matchMedia("(pointer: coarse)").matches || innerWidth < 700;

const T = { step: -1, els: null, raf: 0, timer: 0, done: new Set(), rings: [], cur: null, lastT: 0, label: "", shown: 0 };

const STEPS = [
  { // 1: library button
    target: () => document.querySelector('.top-actions button[onclick*="toggleLibrary"]'),
    label: "Library",
    clickNext: true,
  },
  { // 2: add songs (no text)
    target: () => document.querySelector("#libraryPanel .lib-add-btn"),
    label: "",
    clickNext: true,
    after: () => (isPhone() ? finish(true) : null),
  },
  { // 3: the helper downloads - each one ticks off when clicked
    enter() {
      if (helperOk()) return go(4), true; // already set up
      const s = $("finderSetup");
      if (s) s.hidden = false;
    },
    target: () => $("finderSetup") && $("finderSetup").querySelector("ol li:first-child"),
    extra: () => [$("finderSetup") && $("finderSetup").querySelector("ol li:nth-child(2)")],
    links: () => {
      const s = $("finderSetup");
      if (!s) return [];
      return [...s.querySelectorAll('a[href*="okmusic-helper.py"], a[href*="Helper.bat"], a[href*="python.org"]')];
    },
    label: "Get these 3 to download songs from YouTube + Spotify playlists",
    noFinger: true,
  },
  { // 4: start the helper, come back
    enter() {
      if (helperOk()) return go(4), true;
      const s = $("finderSetup");
      if (s) s.hidden = false;
    },
    target: () => $("finderSetup") && $("finderSetup").querySelector("ol li:nth-child(2) b"),
    extra: () => [$("finderSetup") && $("finderSetup").querySelector("ol li:nth-child(3)")],
    label: "Open Start okMUSIC Helper.bat, then come back here",
    waitHelper: true,
    noFinger: true,
  },
  { // 5: search / playlist
    target: () => $("finderTabs"),
    label: "Search any song, or paste a Spotify / YouTube playlist",
    clickNext: true,
    after: () => finish(true),
  },
];
const visibleSteps = () => (isPhone() ? 2 : STEPS.length);

function helperOk() {
  const st = $("finderStatus");
  return !!(st && st.classList.contains("ok"));
}

function mk(cls, tag = "div") {
  const d = document.createElement(tag);
  d.className = cls;
  document.body.appendChild(d);
  return d;
}

function build() {
  if (T.els) return;
  // four see-through blocks around the hole: they catch stray taps (the dimming is the spotlight's shadow)
  const blocks = [0, 1, 2, 3].map(() => mk("pt-block"));
  const spot = mk("pt-spot");
  spot.innerHTML = '<i class="pt-ripple"></i><i class="pt-ripple pt-ripple2"></i>';
  const finger = mk("pt-finger");
  finger.innerHTML = '<i class="fa-solid fa-hand-pointer"></i>';
  const label = mk("pt-label");
  const dots = mk("pt-dots");
  const skip = mk("pt-skip", "button");
  skip.textContent = "skip";
  skip.onclick = () => finish(false);
  T.els = { blocks, spot, finger, label, dots, skip };
  requestAnimationFrame(() => document.body.classList.add("pt-on"));
  document.addEventListener("click", onClick, true);
}

function rectOf(list) {
  let r = null;
  for (const el of list) {
    if (!el || !el.isConnected) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) continue;
    r = r
      ? { left: Math.min(r.left, b.left), top: Math.min(r.top, b.top), right: Math.max(r.right, b.right), bottom: Math.max(r.bottom, b.bottom) }
      : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  }
  return r;
}

function setLabel(text) {
  const { label } = T.els;
  if (text === T.label) return;
  T.label = text;
  label.textContent = text;
  label.classList.remove("pt-pop");
  void label.offsetWidth; // restart the pop-in
  if (text) label.classList.add("pt-pop");
}

function paintDots() {
  const n = visibleSteps();
  const { dots } = T.els;
  if (dots.childElementCount !== n) dots.innerHTML = "<i></i>".repeat(n);
  [...dots.children].forEach((d, i) => {
    d.classList.toggle("on", i === T.step);
    d.classList.toggle("past", i < T.step);
  });
}

function place(dt) {
  const s = STEPS[T.step];
  if (!s || !T.els) return;
  const main = s.target();
  const r = rectOf([main, ...(s.extra ? s.extra() : [])]);
  const { blocks, spot, label, finger } = T.els;
  const W = innerWidth, H = innerHeight;
  if (!r) {
    // target not on screen (panel closed etc.): no dimming until it comes back
    blocks.forEach((b) => (b.style.display = "none"));
    spot.style.opacity = label.style.opacity = finger.style.opacity = "0";
    return;
  }
  const pad = 8;
  const tgt = { l: r.left - pad, t: r.top - pad, r: r.right + pad, b: r.bottom + pad };
  // the spotlight glides (starts as the whole screen, then shrinks onto the first target)
  if (!T.cur) T.cur = { l: -40, t: -40, r: W + 40, b: H + 40 };
  const k = 1 - Math.exp(-dt * 11);
  for (const key of ["l", "t", "r", "b"]) T.cur[key] += (tgt[key] - T.cur[key]) * k;
  const c = T.cur;
  const L = Math.max(0, c.l), Tp = Math.max(0, c.t), R = Math.min(W, c.r), B = Math.min(H, c.b);
  const set = (el, x, y, w, h) => {
    el.style.display = "block";
    el.style.transform = `translate(${x}px,${y}px)`;
    el.style.width = Math.max(0, w) + "px";
    el.style.height = Math.max(0, h) + "px";
  };
  set(blocks[0], 0, 0, W, Tp);
  set(blocks[1], 0, B, W, H - B);
  set(blocks[2], 0, Tp, L, B - Tp);
  set(blocks[3], R, Tp, W - R, B - Tp);
  set(spot, c.l, c.t, c.r - c.l, c.b - c.t);
  spot.style.opacity = "1";
  // round for small buttons, rounded box for big areas
  const small = c.r - c.l < 80 && c.b - c.t < 80;
  spot.style.borderRadius = small ? "999px" : "16px";

  // tapping finger, bottom-right of the target
  const showFinger = !s.noFinger && !s.links;
  finger.style.opacity = showFinger ? "1" : "0";
  if (showFinger) finger.style.transform = `translate(${Math.min(W - 40, c.r - 14)}px,${Math.min(H - 44, c.b - 12)}px)`;

  setLabel(s.label || "");
  if (s.label) {
    label.style.opacity = "1";
    const lw = Math.min(290, W - 24);
    label.style.maxWidth = lw + "px";
    const lh = label.offsetHeight || 40, lwid = label.offsetWidth || lw;
    const below = B + 18 + lh < H - 60;
    const cx = (L + R) / 2;
    const x = Math.max(12, Math.min(W - 12 - lwid, cx - lwid / 2));
    label.classList.toggle("pt-above", !below);
    // arrow points at the middle of the target
    label.style.setProperty("--ax", Math.max(16, Math.min(lwid - 16, cx - x)) + "px");
    label.style.transform = `translate(${x}px,${below ? B + 16 : Math.max(10, Tp - 16 - lh)}px)`;
  } else label.style.opacity = "0";

  // pulsing rings on each download link (they tick when clicked)
  const links = s.links ? s.links() : [];
  while (T.rings.length < links.length) T.rings.push(mk("pt-ring"));
  T.rings.forEach((ring, i) => {
    const a = links[i];
    const b = a && a.getBoundingClientRect();
    if (!b || b.width < 2) return (ring.style.display = "none");
    ring.style.display = "block";
    ring.classList.toggle("done", T.done.has(a.href));
    ring.style.transform = `translate(${b.left - 5}px,${b.top - 4}px)`;
    ring.style.width = b.width + 10 + "px";
    ring.style.height = b.height + 8 + "px";
  });
}

function loop() {
  cancelAnimationFrame(T.raf);
  T.lastT = performance.now();
  const step = (now) => {
    if (T.step < 0) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - T.lastT) / 1000));
    T.lastT = now;
    place(dt);
    T.raf = requestAnimationFrame(step);
  };
  T.raf = requestAnimationFrame(step);
}

function go(i) {
  T.step = i;
  clearInterval(T.timer);
  T.rings.forEach((r) => r.remove());
  T.rings = [];
  const s = STEPS[i];
  if (!s) return finish(true);
  build();
  paintDots();
  if (s.enter && s.enter() === true) return; // enter() jumped to another step
  if (s.waitHelper) {
    T.timer = setInterval(() => {
      if (T.step === i && helperOk()) go(i + 1);
    }, 700);
  }
  loop();
}

function onClick(e) {
  if (T.step < 0) return;
  const s = STEPS[T.step];
  const t = s.target();
  if (s.links) {
    const a = e.target.closest && e.target.closest("a");
    const links = s.links();
    if (a && links.includes(a)) {
      T.done.add(a.href);
      if (links.every((l) => T.done.has(l.href))) setTimeout(() => T.step === 2 && go(3), 600);
    }
    return;
  }
  if (s.clickNext && t && t.contains(e.target)) {
    const i = T.step;
    // let the real click happen first (opens the panel), then move on
    setTimeout(() => {
      if (T.step !== i) return;
      if (s.after && s.after() !== null && T.step < 0) return;
      if (T.step === i) go(i + 1);
    }, 350);
  }
}

// completed = played all the way through (gets the little "all set" burst); skip = just fade out
function finish(completed) {
  const was = T.step >= 0 && T.els;
  T.step = -1;
  clearInterval(T.timer);
  cancelAnimationFrame(T.raf);
  localStorage.setItem(KEY, "1");
  document.removeEventListener("click", onClick, true);
  T.rings.forEach((r) => r.remove());
  T.rings = [];
  T.cur = null;
  T.label = "";
  if (!T.els) return;
  const els = T.els;
  T.els = null;
  document.body.classList.remove("pt-on");
  els.blocks.forEach((b) => b.remove()); // taps work again right away
  els.spot.classList.add("pt-out");
  for (const el of [els.finger, els.label, els.dots, els.skip]) el.classList.add("pt-fade");
  setTimeout(() => [els.spot, els.finger, els.label, els.dots, els.skip].forEach((el) => el.remove()), 600);
  if (was && completed === true) {
    const done = mk("pt-done");
    done.innerHTML = '<span class="pt-done-check"><i class="fa-solid fa-check"></i></span><span>You\'re all set</span>';
    for (let i = 0; i < 14; i++) {
      const p = document.createElement("i");
      p.className = "pt-spark";
      p.style.setProperty("--a", (i / 14) * 360 + "deg");
      p.style.setProperty("--d", 50 + (i % 3) * 18 + "px");
      done.appendChild(p);
    }
    setTimeout(() => done.classList.add("pt-fade"), 1900);
    setTimeout(() => done.remove(), 2500);
  }
}

function start() {
  finish(false);
  localStorage.removeItem(KEY);
  T.done.clear();
  go(0);
}

window.tutorial = { start, stop: () => finish(false) };

// first visit only (and not when opened as a phone remote / jam invite)
const q = new URLSearchParams(location.search);
if (!localStorage.getItem(KEY) && !q.get("remote") && !q.get("jam")) setTimeout(() => go(0), 1200);
