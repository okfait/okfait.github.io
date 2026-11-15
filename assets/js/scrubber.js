// The song slider (v2.14.0).
//  - thin rounded bar that glides every frame (it used to jump 4 times a second)
//  - hover (PC): the bar gets thicker, the dot appears, a bubble shows the time under your mouse
//    and a faint "ghost" fill shows where you'd jump to
//  - click / tap anywhere or drag the dot. Touch works anywhere on the bar (iPhone sliders only
//    let you grab the dot itself). The song jumps when you let go.
//  - the time on the left rolls: the old digit slides DOWN + blurs out, the new one drops in
//    from the TOP + un-blurs
// Seeking still goes through the old hidden #progressBar input, so Jam (guest) and the phone
// remote keep sending "seek" to the host / PC exactly like before.

const $ = (id) => document.getElementById(id);
const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

const K = { drag: false, pct: 0, hover: -1, lastText: "", lastTot: "", raf: 0, built: false };

function build() {
  const input = $("progressBar");
  if (!input || K.built) return !!K.built;
  const wrap = document.createElement("div");
  wrap.className = "seek";
  wrap.id = "seekWrap";
  wrap.innerHTML =
    '<div class="seek-track"><div class="seek-ghost"></div><div class="seek-fill"></div></div>' +
    '<div class="seek-thumb"></div><div class="seek-tip">0:00</div>';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input); // kept (hidden) for Jam / remote / old code
  input.tabIndex = -1;
  input.step = "any"; // exact jumps (step 1 = whole percents = up to 2-3 s off)
  K.wrap = wrap;
  K.input = input;
  K.fill = wrap.querySelector(".seek-fill");
  K.ghost = wrap.querySelector(".seek-ghost");
  K.thumb = wrap.querySelector(".seek-thumb");
  K.tip = wrap.querySelector(".seek-tip");
  K.cur = $("currTime");
  K.tot = $("totTime");
  if (K.cur) K.cur.classList.add("roll-time");
  K.built = true;

  const pctAt = (e) => {
    const r = K.wrap.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
  };
  wrap.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    const a = audio();
    if (!a || !a.duration) return;
    K.drag = true;
    K.pct = pctAt(e);
    wrap.classList.add("dragging");
    try {
      wrap.setPointerCapture(e.pointerId);
    } catch (_) {}
    paint();
    e.preventDefault();
  });
  wrap.addEventListener("pointermove", (e) => {
    const p = pctAt(e);
    if (K.drag) K.pct = p;
    else if (e.pointerType === "mouse") K.hover = p;
    paint();
  });
  const end = (e, cancel) => {
    if (!K.drag) return;
    K.drag = false;
    wrap.classList.remove("dragging");
    if (!cancel) seek(K.pct);
    paint();
  };
  wrap.addEventListener("pointerup", (e) => end(e, false));
  wrap.addEventListener("pointercancel", (e) => end(e, true));
  wrap.addEventListener("pointerleave", () => {
    K.hover = -1;
    paint();
  });
  return true;
}

function audio() {
  return window.audioSys && window.audioSys.audio;
}

// same path the old slider used: set the hidden input + fire "input"
// (Jam guest / phone remote catch it and ask the host / PC to seek instead)
function seek(p) {
  const a = audio();
  if (!a || !a.duration) return;
  K.input.value = p * 100;
  K.input.dispatchEvent(new Event("input", { bubbles: true }));
  K.input.dispatchEvent(new Event("change", { bubbles: true }));
  K.seekedAt = performance.now();
  K.seekPct = p;
}

function paint() {
  if (!K.built) return;
  const a = audio();
  const dur = a && a.duration;
  let p = 0;
  if (K.drag) p = K.pct;
  else if (dur) {
    p = a.currentTime / dur;
    // right after a seek the song may take a moment to get there: don't flick back
    if (K.seekedAt && performance.now() - K.seekedAt < 600 && Math.abs(p - K.seekPct) > 0.01) p = K.seekPct;
  }
  p = Math.max(0, Math.min(1, p || 0));
  K.fill.style.transform = `scaleX(${p})`;
  K.thumb.style.left = p * 100 + "%";
  const showTip = K.drag || K.hover >= 0;
  K.wrap.classList.toggle("tip-on", showTip);
  if (showTip && dur) {
    const tp = K.drag ? K.pct : K.hover;
    K.tip.textContent = fmt(tp * dur);
    K.tip.style.left = tp * 100 + "%";
    if (!K.drag && K.hover >= 0) {
      const lo = Math.min(p, K.hover), hi = Math.max(p, K.hover);
      K.ghost.style.left = lo * 100 + "%";
      K.ghost.style.width = (hi - lo) * 100 + "%";
    }
  }
  K.wrap.classList.toggle("ghost-on", !K.drag && K.hover >= 0);
  setTexts(K.drag ? K.pct * (dur || 0) : a ? a.currentTime : 0, dur);
}

// ---------------------------------------------------------------- rolling time
function setTexts(cur, dur) {
  const tot = dur ? fmt(dur) : "--:--";
  if (K.tot && tot !== K.lastTot) {
    K.tot.textContent = tot;
    K.lastTot = tot;
  }
  roll(dur ? fmt(cur) : "0:00");
}
function roll(text) {
  const el = K.cur;
  if (!el || text === K.lastText) return;
  const prev = K.lastText;
  K.lastText = text;
  // first time / different length (9:59 -> 10:00): rebuild the boxes, no animation
  if (prev.length !== text.length || !el.querySelector(".rt-ch")) {
    el.textContent = "";
    for (const ch of text) {
      const box = document.createElement("span");
      box.className = ch === ":" ? "rt-ch rt-colon" : "rt-ch";
      const inner = document.createElement("span");
      inner.className = "rt-d";
      inner.textContent = ch;
      box.appendChild(inner);
      el.appendChild(box);
    }
    return;
  }
  const boxes = el.querySelectorAll(".rt-ch");
  const instant = document.hidden || window.okAway;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === prev[i]) continue;
    const box = boxes[i];
    // anything still leaving from a fast change: drop it
    box.querySelectorAll(".rt-out").forEach((n) => n.remove());
    const old = box.querySelector(".rt-d:not(.rt-out)");
    const nu = document.createElement("span");
    nu.className = instant ? "rt-d" : "rt-d rt-in";
    nu.textContent = text[i];
    box.appendChild(nu);
    if (old) {
      if (instant) old.remove();
      else {
        old.classList.remove("rt-in");
        old.classList.add("rt-out");
        old.addEventListener("animationend", () => old.remove(), { once: true });
        setTimeout(() => old.remove(), 600);
      }
    }
  }
}

// ---------------------------------------------------------------- glide every frame while playing
function loop() {
  K.raf = requestAnimationFrame(loop);
  if (document.hidden || window.okAway) return;
  const a = audio();
  if (!a) return;
  if (a.paused && !K.drag && !K.dirty) return;
  K.dirty = false;
  paint();
}

function init() {
  if (!build()) return setTimeout(init, 300);
  // old code calls ui.updateProgress() on every tick: just mark "draw me" (the loop draws)
  const hook = () => {
    if (!window.ui) return setTimeout(hook, 200);
    window.ui.updateProgress = () => {
      K.dirty = true;
      if (audio() && audio().paused) paint();
    };
  };
  hook();
  K.dirty = true;
  loop();
}
init();

window.scrubber = { paint, seek };
