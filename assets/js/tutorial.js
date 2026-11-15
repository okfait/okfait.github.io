// okMUSIC first-visit tutorial ("PT" = pulsating tutorial).
// Almost no text: the thing you should press glows + pulses, everything else goes dark.
//   1. Library button ("Library")   2. Add Songs   3. the helper downloads (each one ticks off)
//   4. "Start okMUSIC Helper.bat" + come back   5. Search / Playlist tabs once the helper connects
// Shows once. "skip" in the corner ends it. Phones stop after step 2 (the helper is PC-only).
// Run it again any time: window.tutorial.start()

const KEY = "okmusic_tut_done";
const $ = (id) => document.getElementById(id);
const isPhone = () => matchMedia("(pointer: coarse)").matches || innerWidth < 700;

const T = { step: -1, els: null, raf: 0, timer: 0, done: new Set(), rings: [] };

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
    after: () => (isPhone() ? finish() : null),
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
  },
  { // 5: search / playlist
    target: () => $("finderTabs"),
    label: "Search any song, or paste a Spotify / YouTube playlist",
    clickNext: true,
    after: () => finish(),
  },
];

function helperOk() {
  const st = $("finderStatus");
  return !!(st && st.classList.contains("ok"));
}

function build() {
  if (T.els) return;
  const mk = (cls) => {
    const d = document.createElement("div");
    d.className = cls;
    document.body.appendChild(d);
    return d;
  };
  // four dark blocks around the hole: they dim everything else AND catch stray taps
  const blocks = [0, 1, 2, 3].map(() => mk("pt-block"));
  const hole = mk("pt-hole");
  const label = mk("pt-label");
  const skip = document.createElement("button");
  skip.className = "pt-skip";
  skip.textContent = "skip";
  skip.onclick = finish;
  document.body.appendChild(skip);
  T.els = { blocks, hole, label, skip };
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

function place() {
  const s = STEPS[T.step];
  if (!s || !T.els) return;
  const main = s.target();
  const r = rectOf([main, ...(s.extra ? s.extra() : [])]);
  const { blocks, hole, label } = T.els;
  const W = innerWidth, H = innerHeight;
  if (!r) {
    // target not on screen (panel closed etc.): no dimming until it comes back
    blocks.forEach((b) => (b.style.display = "none"));
    hole.style.display = label.style.display = "none";
  } else {
    const pad = 8;
    const L = Math.max(0, r.left - pad), Tp = Math.max(0, r.top - pad), R = Math.min(W, r.right + pad), B = Math.min(H, r.bottom + pad);
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
    set(hole, L, Tp, R - L, B - Tp);
    if (s.label) {
      label.style.display = "block";
      label.textContent = s.label;
      const lw = Math.min(280, W - 24);
      label.style.width = "auto";
      label.style.maxWidth = lw + "px";
      const lh = label.offsetHeight || 40;
      const below = B + 14 + lh < H - 10;
      const x = Math.max(12, Math.min(W - 12 - Math.min(lw, label.offsetWidth || lw), (L + R) / 2 - (label.offsetWidth || lw) / 2));
      label.style.transform = `translate(${x}px,${below ? B + 14 : Math.max(10, Tp - 14 - lh)}px)`;
    } else label.style.display = "none";
  }
  // pulsing rings on each download link (they tick when clicked)
  const links = s.links ? s.links() : [];
  while (T.rings.length < links.length) {
    const d = document.createElement("div");
    d.className = "pt-ring";
    document.body.appendChild(d);
    T.rings.push(d);
  }
  T.rings.forEach((ring, i) => {
    const a = links[i];
    const b = a && a.getBoundingClientRect();
    if (!b || b.width < 2) return (ring.style.display = "none");
    ring.style.display = "block";
    ring.classList.toggle("done", T.done.has(a.href));
    ring.style.transform = `translate(${b.left - 4}px,${b.top - 3}px)`;
    ring.style.width = b.width + 8 + "px";
    ring.style.height = b.height + 6 + "px";
  });
}

function loop() {
  cancelAnimationFrame(T.raf);
  const step = () => {
    if (T.step < 0) return;
    place();
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
  if (!s) return finish();
  build();
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
      if (links.every((l) => T.done.has(l.href))) setTimeout(() => T.step === 2 && go(3), 500);
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

function finish() {
  T.step = -1;
  clearInterval(T.timer);
  cancelAnimationFrame(T.raf);
  localStorage.setItem(KEY, "1");
  if (T.els) {
    T.els.blocks.forEach((b) => b.remove());
    T.els.hole.remove();
    T.els.label.remove();
    T.els.skip.remove();
    T.els = null;
  }
  T.rings.forEach((r) => r.remove());
  T.rings = [];
  document.removeEventListener("click", onClick, true);
}

function start() {
  finish();
  localStorage.removeItem(KEY);
  T.done.clear();
  go(0);
}

window.tutorial = { start, stop: finish };

// first visit only (and not when opened as a phone remote / jam invite)
const q = new URLSearchParams(location.search);
if (!localStorage.getItem(KEY) && !q.get("remote") && !q.get("jam")) setTimeout(() => go(0), 1200);
