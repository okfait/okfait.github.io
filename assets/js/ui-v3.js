// okMUSIC v3 UI glue: dropdown menus, clean-display exit, Liquid Tuner open/close,
// accent swatches, visualizer style switch, slider fill. Loads after app.js.

const $ = (id) => document.getElementById(id);

const ACCENTS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#00c7be", "#60a5fa", "#5e5ce6", "#bf5af2", "#ff2d55", "#ffffff"];

const TUNER_DEFAULTS = {
  tuneWidthSlider: 0.85, tuneSensSlider: 1.0, tunePosSlider: 16, tuneBgGapSlider: 10,
  tuneBassEndSlider: 5, tuneBassThreshSlider: 0.5, tuneBassSquashSlider: 4.0,
  tuneMidStartSlider: 15, tuneMidEndSlider: 25, tuneMidThreshSlider: 0.4, tuneMidSquashSlider: 3.0,
  tuneHighStartSlider: 35, tuneHighEndSlider: 45, tuneHighThreshSlider: 0.35, tuneHighSquashSlider: 2.5,
  tuneTickStartSlider: 80, tuneTickEndSlider: 120, tuneTickThreshSlider: 0.25, tuneTickSquashSlider: 2.0,
};

// ------------------------------------------------------------ slider fill (the colored part left of the knob)
function paintSlider(el) {
  const min = parseFloat(el.min || 0), max = parseFloat(el.max || 100);
  const p = ((parseFloat(el.value) - min) / (max - min || 1)) * 100;
  el.style.setProperty("--p", Math.max(0, Math.min(100, p)) + "%");
}
function paintAll() {
  document.querySelectorAll("input[type=range].setting-slider").forEach(paintSlider);
}
document.addEventListener("input", (e) => {
  if (e.target.matches && e.target.matches("input[type=range].setting-slider")) paintSlider(e.target);
});

// ------------------------------------------------------------ dropdown menus
function closeMenus(except) {
  document.querySelectorAll(".ios-menu.open").forEach((m) => {
    if (m !== except) m.classList.remove("open");
  });
  document.querySelectorAll(".ios-select-btn.open").forEach((b) => {
    if (!except || !b.parentElement.contains(except)) b.classList.remove("open");
  });
}
function toggleMenu(id, btn) {
  const m = $(id);
  if (!m) return;
  const willOpen = !m.classList.contains("open");
  closeMenus(m);
  m.classList.toggle("open", willOpen);
  if (btn && btn.classList.contains("ios-select-btn")) btn.classList.toggle("open", willOpen);
  if (willOpen) {
    const sel = m.querySelector(".selected");
    // scroll only inside the menu (scrollIntoView would shove the whole page sideways)
    if (sel) m.scrollTop = Math.max(0, sel.offsetTop - m.clientHeight / 2 + sel.offsetHeight / 2);
  }
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".ios-select, .more-wrap")) closeMenus();
});

// Turns a hidden <select data-ios-select> into the same dropdown the Theme row uses.
function enhanceSelect(sel) {
  if (sel.dataset.enhanced) return;
  sel.dataset.enhanced = "1";
  const wrap = document.createElement("div");
  wrap.className = "ios-select";
  const menuId = sel.id + "Menu";
  wrap.innerHTML = `<button type="button" class="ios-select-btn"><span></span> <i class="fa-solid fa-chevron-down"></i></button><div class="ios-menu" id="${menuId}"></div>`;
  sel.insertAdjacentElement("afterend", wrap);
  const btn = wrap.querySelector("button");
  const label = btn.querySelector("span");
  const menu = wrap.querySelector(".ios-menu");
  btn.addEventListener("click", () => toggleMenu(menuId, btn));
  const build = () => {
    menu.innerHTML = "";
    Array.from(sel.options).forEach((o) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = o.textContent;
      if (o.value === sel.value) b.classList.add("selected");
      b.addEventListener("click", () => {
        sel.value = o.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        sync();
        closeMenus();
      });
      menu.appendChild(b);
    });
  };
  const sync = () => {
    const o = sel.options[sel.selectedIndex];
    label.textContent = o ? o.textContent : "";
    menu.querySelectorAll("button").forEach((b, i) => b.classList.toggle("selected", i === sel.selectedIndex));
  };
  build();
  sync();
  sel.addEventListener("change", sync);
  sel._iosSync = sync;
}

// ------------------------------------------------------------ theme: swatches + menu tick
function markSwatch(color) {
  const c = (color || "").toLowerCase();
  document.querySelectorAll("#accentSwatches .swatch").forEach((s) => {
    s.classList.toggle("selected", (s.dataset.color || "") === c);
  });
  const custom = document.querySelector("#accentSwatches .swatch-custom");
  if (custom) custom.classList.toggle("selected", !ACCENTS.includes(c));
}
function buildSwatches() {
  const box = $("accentSwatches");
  if (!box || box.dataset.built) return;
  box.dataset.built = "1";
  const custom = box.querySelector(".swatch-custom");
  ACCENTS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.dataset.color = c;
    b.style.setProperty("--sw", c);
    b.title = c;
    b.addEventListener("click", () => {
      window.ui.setTheme(c);
      if ($("colorPicker")) $("colorPicker").value = c;
      markSwatch(c);
    });
    box.insertBefore(b, custom);
  });
  markSwatch(localStorage.getItem("sv_theme") || "#60a5fa");
}
function markThemeMenu() {
  const names = { solid: 0, "solid-fill": 1, dominant: 2, gradient: 3, rainbow: 4 };
  const idx = names[window.ui && window.ui.themeMode] ?? 0;
  document.querySelectorAll("#themeMenu > button").forEach((b, i) => b.classList.toggle("selected", i === idx));
}

// ------------------------------------------------------------ visualizer style (Ring / Bar / Liquid)
function markVizMode() {
  const mode = window.viz && window.viz.mode;
  document.querySelectorAll("#vizModeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
}
function setVizMode(mode) {
  if (!window.viz) return;
  // the old code only knows "next mode", so step until we land on the one picked
  for (let i = 0; i < 3 && window.viz.mode !== mode; i++) window.viz.toggleMode();
  markVizMode();
}

// ------------------------------------------------------------ Liquid Tuner Pro open/close
function toggleTuner(force) {
  const m = $("vizTunerModal");
  if (!m) return;
  const open = typeof force === "boolean" ? force : m.style.display === "none";
  if (open) {
    // re-center each time it opens (it may have been dragged off before)
    m.style.left = "";
    m.style.top = "";
    m.style.transform = "";
    m.style.display = "flex";
    paintAll();
  } else {
    m.style.display = "none";
  }
  const btn = $("vizTunerOpenBtn");
  if (btn) btn.classList.toggle("active", open);
}
function resetTuner() {
  for (const [id, v] of Object.entries(TUNER_DEFAULTS)) {
    const el = $(id);
    if (el) el.value = v;
  }
  if ($("tuneSparks")) $("tuneSparks").checked = true;
  if ($("tuneBgLines")) $("tuneBgLines").checked = false;
  if ($("tuneMidSweep")) $("tuneMidSweep").checked = false;
  if ($("tuneHideUI")) $("tuneHideUI").checked = false;
  window.updateVizTuning && window.updateVizTuning();
  paintAll();
  window.ui && window.ui.showToast("Tuner back to default");
}
function restoreTuner() {
  // the old code saved tuner values but never put them back on reload
  try {
    const cfg = JSON.parse(localStorage.getItem("okmusic_viz_config") || "null");
    if (!cfg) return;
    const map = {
      tuneWidthSlider: "width", tuneSensSlider: "sens", tunePosSlider: "pos", tuneBgGapSlider: "gap",
      tuneBassEndSlider: "bEnd", tuneBassThreshSlider: "bThr", tuneBassSquashSlider: "bSq",
      tuneMidStartSlider: "mStart", tuneMidEndSlider: "mEnd", tuneMidThreshSlider: "mThr", tuneMidSquashSlider: "mSq",
      tuneHighStartSlider: "hStart", tuneHighEndSlider: "hEnd", tuneHighThreshSlider: "hThr", tuneHighSquashSlider: "hSq",
      tuneTickStartSlider: "tStart", tuneTickEndSlider: "tEnd", tuneTickThreshSlider: "tThr", tuneTickSquashSlider: "tSq",
    };
    for (const [id, key] of Object.entries(map)) if ($(id) && cfg[key] !== undefined) $(id).value = cfg[key];
    if ($("tuneSparks") && cfg.sparks !== undefined) $("tuneSparks").checked = !!cfg.sparks;
    if ($("tuneMidSweep") && cfg.mSweep !== undefined) $("tuneMidSweep").checked = !!cfg.mSweep;
    window.updateVizTuning && window.updateVizTuning();
  } catch (e) {}
}

// ------------------------------------------------------------ clean display: a way back out
let exitTimer = null;
function pokeExit() {
  if (!document.body.classList.contains("display-mode") && !document.body.classList.contains("clean-lines-mode")) return;
  document.body.classList.add("show-exit");
  clearTimeout(exitTimer);
  exitTimer = setTimeout(() => document.body.classList.remove("show-exit"), 2500);
}
function exitClean() {
  if (document.body.classList.contains("clean-lines-mode")) {
    const cb = $("tuneHideUI");
    if (cb) cb.checked = false;
    document.body.classList.remove("clean-lines-mode");
    window.updateVizTuning && window.updateVizTuning();
  }
  if (document.body.classList.contains("display-mode")) window.toggleDisplayMode();
  document.body.classList.remove("show-exit");
}
function wireCleanExit() {
  ["mousemove", "touchstart", "click"].forEach((ev) => document.addEventListener(ev, pokeExit, { passive: true }));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (document.body.classList.contains("display-mode") || document.body.classList.contains("clean-lines-mode")) exitClean();
    else {
      closeMenus();
      toggleTuner(false);
    }
  });
  // leaving fullscreen with the browser's own Esc/F11 also leaves clean display
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && document.body.classList.contains("display-mode")) window.toggleDisplayMode();
  });
  const orig = window.toggleDisplayMode;
  window.toggleDisplayMode = () => {
    orig();
    if (document.body.classList.contains("display-mode")) {
      window.ui && window.ui.showToast("Clean display · Esc or tap Exit to leave");
      pokeExit();
    }
  };
}

// ------------------------------------------------------------ restore stuff the old code forgot
function restoreSmallSettings() {
  const sens = localStorage.getItem("sv_viz_sens");
  if (sens && $("vizSensSlider")) {
    $("vizSensSlider").value = sens;
    window.vizSens = parseFloat(sens);
    $("vizSensVal").innerText = parseFloat(sens).toFixed(1) + "x";
  }
  const bright = localStorage.getItem("sv_bg_bright");
  if (bright && $("bgBrightSlider")) {
    $("bgBrightSlider").value = bright;
    if ($("bgBrightVal")) $("bgBrightVal").innerText = Math.round(bright * 100) + "%";
  }
  const hostFx = localStorage.getItem("sv_host_fx");
  if (hostFx !== null && $("hostFxToggle")) $("hostFxToggle").checked = hostFx === "true";
  const g1 = $("gradColor1"), g2 = $("gradColor2");
  if (g1) g1.parentElement.style.background = g1.value;
  if (g2) g2.parentElement.style.background = g2.value;
}

function init() {
  if (!window.ui) return console.warn("ui-v3: app not ready");

  // theme menu tick follows the real mode
  const origMode = window.ui.setThemeMode.bind(window.ui);
  window.ui.setThemeMode = (mode) => {
    origMode(mode);
    markThemeMenu();
    const grad = $("gradientColorContainer");
    if (grad) grad.classList.toggle("hidden", mode !== "gradient");
  };
  // keep the swatch ring on the right color whatever changes the theme
  const origTheme = window.ui.setTheme.bind(window.ui);
  window.ui.setTheme = (c) => {
    origTheme(c);
    markSwatch(c);
  };

  // repaint slider fills whenever a panel opens (code sets values without "input" events)
  for (const fn of ["toggleSettings", "toggleLibrary", "toggleQueue"]) {
    const orig = window.ui[fn] && window.ui[fn].bind(window.ui);
    if (!orig) continue;
    window.ui[fn] = (...a) => {
      const r = orig(...a);
      closeMenus();
      requestAnimationFrame(paintAll);
      return r;
    };
  }

  // a song switch can load that song's bass/speed into the sliders
  const origPlay = window.player && window.player.play && window.player.play.bind(window.player);
  if (origPlay) {
    window.player.play = (...a) => {
      const r = origPlay(...a);
      setTimeout(paintAll, 50);
      return r;
    };
  }

  document.querySelectorAll("select[data-ios-select]").forEach(enhanceSelect);
  buildSwatches();
  wireCleanExit();

  // old settings load runs ~once at boot; wait for it, then fix up the new controls
  setTimeout(() => {
    restoreSmallSettings();
    restoreTuner();
    const f = $("fontSelector");
    if (f && f._iosSync) f._iosSync();
    markThemeMenu();
    markVizMode();
    if ($("gradientColorContainer")) $("gradientColorContainer").classList.toggle("hidden", window.ui.themeMode !== "gradient");
    paintAll();
  }, 1200);

  window.uiv3 = { toggleMenu, closeMenus, markSwatch, setVizMode, toggleTuner, resetTuner, restoreTuner, exitClean, paintAll, enhanceSelect };
}

window.uiv3 = { toggleMenu, closeMenus, markSwatch, setVizMode, toggleTuner, resetTuner, restoreTuner, exitClean, paintAll, enhanceSelect };
init();

// =====================================================================
// v2.12 additions
// =====================================================================

// ------------------------------------------------------------ volume: remember it between visits
function setupVolumeMemory() {
  const as = window.audioSys;
  if (!as) return;
  let saved = parseFloat(localStorage.getItem("okmusic_volume"));
  if (!(saved >= 0 && saved <= 1)) saved = null;
  const origSet = as.setVolume.bind(as);
  let ready = false; // ignore the app's own "animate to 100%" at startup
  as.setVolume = (v) => {
    v = Math.max(0, Math.min(1, parseFloat(v)));
    as._wantVol = v;
    origSet(v);
    if (ready) {
      try { localStorage.setItem("okmusic_volume", String(v)); } catch (e) {}
    }
  };
  // the sound engine is only built on the first play, so put the volume in then
  const origInit = as.init.bind(as);
  as.init = async (...a) => {
    const had = !!as.gain;
    const r = await origInit(...a);
    if (!had && as.gain && as._wantVol != null) as.gain.gain.value = as._wantVol;
    return r;
  };
  const showVol = (v) => {
    const sl = document.querySelector(".vol-slider");
    if (sl) sl.value = v;
    const txt = $("volPercentDisplay");
    if (txt) txt.value = Math.round(v * 100) + "%";
    as.setVolume(v);
  };
  // the app animates the volume label to 100% ~0.5s after loading; land after it
  setTimeout(() => {
    if (saved != null) showVol(saved);
    ready = true;
  }, 900);
  // arrow up/down change the volume directly, remember those too
  window.addEventListener("keyup", (e) => {
    if ((e.code === "ArrowUp" || e.code === "ArrowDown") && as.gain && e.target.tagName !== "INPUT") {
      const v = Math.round(as.gain.gain.value * 100) / 100;
      showVol(v);
    }
  });
}

// ------------------------------------------------------------ cover art hidden inside mp3 files
// Lots of downloaded mp3s carry their cover inside the file (ID3 "APIC"). The old code never
// read it, so those songs showed a grey square. This pulls it out once and saves it.
function syncsafe(b, i) {
  return ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
}
async function readId3Cover(blob) {
  const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
  if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null; // "ID3"
  const ver = head[3];
  if (ver < 3) return null;
  const size = syncsafe(head, 6);
  const buf = new Uint8Array(await blob.slice(10, 10 + Math.min(size, 6e6)).arrayBuffer());
  let p = 0;
  if (head[5] & 0x40) p = ver === 4 ? syncsafe(buf, 0) : ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) + 4;
  while (p + 10 < buf.length) {
    const id = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fs = ver === 4 ? syncsafe(buf, p + 4) : (buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7];
    if (fs <= 0) break;
    if (id === "APIC") {
      const f = buf.subarray(p + 10, p + 10 + fs);
      const enc = f[0];
      let i = 1;
      const mimeEnd = f.indexOf(0, i);
      let mime = String.fromCharCode(...f.subarray(i, mimeEnd)).toLowerCase() || "image/jpeg";
      if (!mime.includes("/")) mime = "image/" + (mime === "jpg" ? "jpeg" : mime);
      i = mimeEnd + 2; // skip the 0 and the picture-type byte
      if (enc === 1 || enc === 2) {
        while (i + 1 < f.length && !(f[i] === 0 && f[i + 1] === 0)) i += 2;
        i += 2;
      } else {
        while (i < f.length && f[i] !== 0) i++;
        i++;
      }
      return new Blob([f.subarray(i)], { type: mime });
    }
    p += 10 + fs;
  }
  return null;
}
async function smallDataUrl(imgBlob, px = 320) {
  const bmp = await createImageBitmap(imgBlob);
  const c = document.createElement("canvas");
  const s = Math.min(1, px / Math.max(bmp.width, bmp.height));
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return c.toDataURL("image/jpeg", 0.85);
}
let artScanRunning = false;
async function scanMissingCovers() {
  if (artScanRunning || !window.player || !window.player.songs) return;
  artScanRunning = true;
  let found = 0;
  try {
    for (const s of window.player.songs) {
      if (s.art || s.artChecked || !s.blob) continue;
      let art = null;
      try {
        const img = await readId3Cover(s.blob);
        if (img && img.size > 500) art = await smallDataUrl(img);
      } catch (e) {}
      s.artChecked = true;
      if (art) {
        s.art = art;
        found++;
      }
      await window.player.db.update(s.id, art ? { art, artChecked: true } : { artChecked: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 30)); // gentle, in the background
    }
  } finally {
    artScanRunning = false;
  }
  if (found) {
    window.ui.renderLibrary && window.ui.renderLibrary();
    renderQueue();
    const cur = window.player.currentTrack;
    if (cur && cur.art && window.ui.setTrack) window.ui.setTrack(cur);
  }
}

// ------------------------------------------------------------ queue: covers + drag to reorder
const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function phGradient(name) {
  let h = 0;
  for (const ch of name || "") h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 70% 45%), hsl(${(h + 50) % 360} 70% 30%))`;
}
function renderQueue() {
  const list = $("queueList");
  if (!list || !window.player) return;
  const q = window.player.queue || [];
  if (!q.length) {
    list.innerHTML = `<div class="q-empty"><i class="fa-solid fa-list-ul" style="font-size:22px;display:block;margin-bottom:8px;opacity:.5"></i>Queue is empty.<br>Right-click a song → Add to Queue.</div>`;
    return;
  }
  list.innerHTML = q
    .map((id, idx) => {
      const s = (window.player.songs || []).find((x) => x.id === id);
      if (!s) return "";
      const art = s.art
        ? `<div class="q-art" style="background-image:url('${s.art}')"></div>`
        : `<div class="q-art ph" style="background:${phGradient(s.name)}"><i class="fa-solid fa-music"></i></div>`;
      return `<div class="q-row" data-idx="${idx}">
        <span class="q-grip" title="Drag to move"><i class="fa-solid fa-grip-vertical"></i></span>
        ${art}
        <div class="q-name">${escHtml(s.name)}</div>
        <button class="q-x" title="Remove" onclick="window.player.removeFromQueue(${idx})"><i class="fa-solid fa-xmark"></i></button>
      </div>`;
    })
    .join("");
}
function wireQueueDrag() {
  const list = $("queueList");
  if (!list) return;
  let drag = null;
  list.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest(".q-grip");
    if (!grip) return;
    const row = grip.closest(".q-row");
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const rows = [...list.querySelectorAll(".q-row")];
    drag = { row, grip, from: +row.dataset.idx, to: +row.dataset.idx, startY: e.clientY, rows, h: row.offsetHeight + 6 };
    row.classList.add("dragging");
  });
  list.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    drag.row.style.transform = `translateY(${dy}px) scale(1.02)`;
    const to = Math.max(0, Math.min(drag.rows.length - 1, drag.from + Math.round(dy / drag.h)));
    drag.to = to;
    drag.rows.forEach((r, i) => {
      if (r === drag.row) return;
      let shift = 0;
      if (drag.from < to && i > drag.from && i <= to) shift = -drag.h;
      if (drag.from > to && i < drag.from && i >= to) shift = drag.h;
      r.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  });
  const end = () => {
    if (!drag) return;
    const { from, to } = drag;
    drag = null;
    const q = window.player.queue;
    if (to !== from && q) {
      const [id] = q.splice(from, 1);
      q.splice(to, 0, id);
    }
    renderQueue();
  };
  list.addEventListener("pointerup", end);
  list.addEventListener("pointercancel", end);
}

// ------------------------------------------------------------ "Connect" button in the library
function updateConnect() {
  const sp = window.spotify;
  const on = !!(sp && sp.isConnected());
  const name = on && sp.profile && sp.profile.display_name;
  const btn = $("connectBtn");
  if (btn) btn.classList.toggle("connected", on);
  if ($("connectTxt")) $("connectTxt").textContent = on ? "Connected" : "Connect";
  if ($("connectSpotifyInfo")) $("connectSpotifyInfo").textContent = on ? `Spotify: connected${name ? " as " + name : ""}` : "Spotify: not connected";
  const act = $("connectSpotifyAct");
  if (act) act.querySelector("span").textContent = on ? "Disconnect Spotify" : "Connect Spotify";
}

// ------------------------------------------------------------ Liquid V1 / V2
function markLiquidVer() {
  const v = localStorage.getItem("okmusic_liquid_ver") || "v2"; // V2 is the default since v2.15.0
  document.querySelectorAll("#liquidVerSeg button").forEach((b) => b.classList.toggle("active", b.dataset.ver === v));
}
function setLiquidVer(v) {
  localStorage.setItem("okmusic_liquid_ver", v);
  markLiquidVer();
  if (v === "v2" && window.viz && window.viz.mode !== "liquid") setVizMode("liquid");
  if (window.liquidV2 && window.liquidV2.reset) window.liquidV2.reset();
}

function initV212() {
  setupVolumeMemory();
  if (window.ui) {
    window.ui.renderQueue = renderQueue;
    wireQueueDrag();
    const origSpUI = window.ui.updateSpotifyUI && window.ui.updateSpotifyUI.bind(window.ui);
    window.ui.updateSpotifyUI = (...a) => {
      const r = origSpUI && origSpUI(...a);
      updateConnect();
      return r;
    };
    // theme name in the label should match the menu
    const origMode = window.ui.setThemeMode;
    window.ui.setThemeMode = (m) => {
      origMode(m);
      if (m === "rainbow" && $("themeModeTxt")) $("themeModeTxt").innerText = "Rainbow Follow";
    };
  }
  updateConnect();
  markLiquidVer();
  // look for covers inside song files once the library has loaded
  setTimeout(scanMissingCovers, 4000);
  if (window.player && window.player.loadLib) {
    const origLoad = window.player.loadLib.bind(window.player);
    window.player.loadLib = async (...a) => {
      const r = await origLoad(...a);
      setTimeout(scanMissingCovers, 1500);
      return r;
    };
  }
  Object.assign(window.uiv3, { setLiquidVer, renderQueue, scanMissingCovers, readId3Cover });
}
initV212();
