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

  window.uiv3 = { toggleMenu, closeMenus, markSwatch, setVizMode, toggleTuner, resetTuner, exitClean, paintAll, enhanceSelect };
}

window.uiv3 = { toggleMenu, closeMenus, markSwatch, setVizMode, toggleTuner, resetTuner, exitClean, paintAll, enhanceSelect };
init();
