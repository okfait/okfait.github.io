// v2.15.0 visualizer + look options (each one remembered after a refresh):
//  - Album Color Tint (Look, on): V2 paints the cover + background in your theme color
//  - Bass Ripple row: on V1 it's the ripple; on V2 it turns into "Beat Effects" (the punch / zoom
//    blur / shake on every kick, on by default). V2 never shows the ripple.
//  - Particles (on): the floating sparks, now in V2 too (same switch as the Tuner's "Sparks")
//  - Spin Cover (off): only the album cover turns, like a record (stops when paused)

const $ = (id) => document.getElementById(id);
// drop (v2.24.0, on by default since v2.26.0): Drop Mode - V2 goes crazy for a few seconds when the beat drops
const KEYS = { tint: ["sv_cover_tint", true], spin: ["sv_spin_cover", false], beatfx: ["sv_v2_beatfx", true], drop: ["sv_drop_mode", true] };

function get(k) {
  const [key, def] = KEYS[k];
  const v = localStorage.getItem(key);
  return v === null ? def : v === "true";
}

function isV2() {
  return !!(window.viz && window.viz.mode === "liquid" && window.liquidV2 && window.liquidV2.active());
}

function apply() {
  document.body.classList.toggle("no-tint", !get("tint"));
  document.body.classList.toggle("spin-cover", get("spin"));
  if ($("coverTintToggle")) $("coverTintToggle").checked = get("tint");
  if ($("spinCoverToggle")) $("spinCoverToggle").checked = get("spin");
  if ($("dropModeToggle")) $("dropModeToggle").checked = get("drop");
  const cfg = window.vizConfig || {};
  if ($("particlesToggle")) $("particlesToggle").checked = cfg.sparks !== false;
  syncRow();
}

function set(k, v) {
  if (k === "particles") {
    // one switch for the sparks: keep the Tuner's checkbox in step and save through it
    if ($("tuneSparks")) $("tuneSparks").checked = v;
    if (typeof window.updateVizTuning === "function") window.updateVizTuning();
    else {
      window.vizConfig = Object.assign(window.vizConfig || {}, { sparks: v });
      localStorage.setItem("okmusic_viz_config", JSON.stringify(window.vizConfig));
    }
  } else localStorage.setItem(KEYS[k][0], v);
  apply();
}

// the ripple row means different things on V1 and V2
function syncRow() {
  const v2 = isV2();
  const lab = $("rippleLabel"), sub = $("rippleSub"), ic = $("rippleIcon"), cb = $("rippleToggle");
  if (!lab || !cb) return;
  lab.textContent = v2 ? "Beat Effects" : "Bass Ripple";
  if (sub) {
    sub.textContent = v2 ? "Punch, zoom blur + shake on every kick" : "";
    sub.hidden = !v2;
  }
  if (ic) ic.className = v2 ? "fa-solid fa-burst" : "fa-solid fa-droplet";
  cb.checked = v2 ? get("beatfx") : !!(window.viz && window.viz.rippleEffect);
}
function rippleRow(on) {
  if (isV2()) localStorage.setItem("sv_v2_beatfx", on);
  else {
    if (window.viz) window.viz.rippleEffect = on;
    localStorage.setItem("sv_ripple", on);
  }
}

// record spins only while music plays
function playingClass() {
  const a = window.audioSys && window.audioSys.audio;
  if (!a) return setTimeout(playingClass, 300);
  const upd = () => document.body.classList.toggle("is-playing", !a.paused);
  for (const ev of ["play", "playing", "pause", "ended", "emptied"]) a.addEventListener(ev, upd);
  upd();
}

// keep the ripple row right when you switch style / liquid version
function wrapUi() {
  const u = window.uiv3;
  if (!u || !u.setLiquidVer || !u.setVizMode) return setTimeout(wrapUi, 300);
  if (u._optsWrapped) return;
  u._optsWrapped = true;
  for (const k of ["setLiquidVer", "setVizMode"]) {
    const orig = u[k];
    u[k] = (...a) => {
      const r = orig(...a);
      syncRow();
      return r;
    };
  }
  apply();
}

window.vizOpts = {
  get,
  set,
  rippleRow,
  syncRow,
  get tint() {
    return get("tint");
  },
  get beatFx() {
    return get("beatfx");
  },
  get dropMode() {
    return get("drop");
  },
  apply,
};
apply();
playingClass();
wrapUi();
setTimeout(apply, 1500); // after the saved visualizer settings have loaded
