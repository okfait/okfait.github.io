// okMUSIC Saved Looks (v2.24.0) - Settings > Visualizer > Saved Looks (folded away until you open it)
//
// A "look" = your theme color + color mode (+ gradient colors), visualizer style, liquid version,
// Liquid Tuner Pro shape, album tint / spin cover / beat effects / drop mode / particles / beat flash /
// liquid lines, sensitivity, background brightness and font. Save as many as you want, tap one to
// switch to it, or share it as a code (paste a friend's code to get their look).

const KEY = "okmusic_looks";
const $ = (id) => document.getElementById(id);
const toast = (m, ms) => window.ui && window.ui.showToast(m, ms);
const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ls = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v === null || v === undefined) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch (e) {}
  },
};
// saved setting name -> where it lives
const FIELDS = {
  theme: "sv_theme",
  mode: "sv_theme_mode",
  g1: "sv_grad_1",
  g2: "sv_grad_2",
  viz: "okmusic_viz_mode",
  ver: "okmusic_liquid_ver",
  tuner: "okmusic_viz_config",
  tint: "sv_cover_tint",
  spin: "sv_spin_cover",
  beatfx: "sv_v2_beatfx",
  drop: "sv_drop_mode",
  flash: "sv_beat_flash",
  lines: "sv_liquid_lines",
  ripple: "sv_ripple",
  sens: "sv_viz_sens",
  bg: "sv_bg_bright",
  font: "sv_font_family",
};

function all() {
  try {
    const a = JSON.parse(ls.get(KEY) || "[]");
    return Array.isArray(a) ? a : [];
  } catch (e) {
    return [];
  }
}
function saveAll(a) {
  ls.set(KEY, JSON.stringify(a));
}

function current() {
  const d = {};
  for (const [k, key] of Object.entries(FIELDS)) {
    const v = ls.get(key);
    if (v !== null) d[k] = v;
  }
  // things that are live but maybe never saved yet
  if (window.viz && window.viz.mode) d.viz = window.viz.mode;
  const acc = document.documentElement.style.getPropertyValue("--accent").trim();
  if (!d.theme && acc) d.theme = acc;
  if (!d.ver) d.ver = "v2";
  return d;
}

// put a look on screen right away (and save it, so it's still there after a refresh)
function apply(d) {
  for (const [k, key] of Object.entries(FIELDS)) if (d[k] !== undefined) ls.set(key, d[k]);
  const ui = window.ui, u3 = window.uiv3 || {}, viz = window.viz;
  const step = (fn) => {
    try {
      fn();
    } catch (e) {
      console.warn("looks:", e);
    }
  };
  step(() => {
    if (d.theme && ui.setTheme) {
      ui.setTheme(d.theme);
      if ($("colorPicker")) $("colorPicker").value = d.theme;
    }
  });
  step(() => {
    if (d.g1 && $("gradColor1")) ($("gradColor1").value = d.g1), ($("gradColor1").parentElement.style.background = d.g1);
    if (d.g2 && $("gradColor2")) ($("gradColor2").value = d.g2), ($("gradColor2").parentElement.style.background = d.g2);
    if (ui.updateGradientTheme) ui.updateGradientTheme();
  });
  step(() => d.mode && ui.setThemeMode && ui.setThemeMode(d.mode));
  step(() => d.font && ui.setFontFamily && (ui.setFontFamily(d.font), $("fontSelector") && ($("fontSelector").value = d.font)));
  // liquid version first: picking V2 also switches the style to Liquid, so the style goes after it
  step(() => d.ver && d.viz === "liquid" && u3.setLiquidVer && u3.setLiquidVer(d.ver));
  step(() => d.viz && u3.setVizMode && u3.setVizMode(d.viz));
  step(() => d.tuner && u3.restoreTuner && u3.restoreTuner());
  step(() => {
    if (!viz) return;
    if (d.flash !== undefined) {
      viz.flash = d.flash !== "false";
      if ($("beatFlashToggle")) $("beatFlashToggle").checked = viz.flash;
      if (!viz.flash && viz.clearFlash) viz.clearFlash();
    }
    if (d.lines !== undefined) {
      viz.smooth = d.lines === "true";
      if ($("liquidLinesToggle")) $("liquidLinesToggle").checked = viz.smooth;
    }
    if (d.ripple !== undefined) viz.rippleEffect = d.ripple !== "false";
  });
  step(() => {
    if (d.sens) {
      window.vizSens = parseFloat(d.sens);
      if ($("vizSensSlider")) $("vizSensSlider").value = d.sens;
      if ($("vizSensVal")) $("vizSensVal").innerText = parseFloat(d.sens).toFixed(1) + "x";
    }
  });
  step(() => {
    if (d.bg && ui.setBgBrightness) {
      ui.setBgBrightness(d.bg);
      if ($("bgBrightSlider")) $("bgBrightSlider").value = d.bg;
      if ($("bgBrightVal")) $("bgBrightVal").innerText = Math.round(d.bg * 100) + "%";
    }
  });
  step(() => window.vizOpts && window.vizOpts.apply && window.vizOpts.apply());
  step(() => window.liquidV2 && window.liquidV2.reset && window.liquidV2.reset());
}

// share code = "OKLOOK-" + the look squeezed into text (LZString is already on the page)
function toCode(look) {
  const json = JSON.stringify({ n: look.name, d: look.d });
  return "OKLOOK-" + (window.LZString ? window.LZString.compressToEncodedURIComponent(json) : btoa(unescape(encodeURIComponent(json))));
}
function fromCode(code) {
  code = String(code || "").trim().replace(/^OKLOOK-/i, "");
  if (!code) return null;
  let json = window.LZString && window.LZString.decompressFromEncodedURIComponent(code);
  if (!json) {
    try {
      json = decodeURIComponent(escape(atob(code)));
    } catch (e) {}
  }
  try {
    const o = JSON.parse(json);
    if (!o || typeof o.d !== "object") return null;
    // only keep known settings, as plain short text
    const d = {};
    for (const k of Object.keys(FIELDS)) if (o.d[k] !== undefined) d[k] = String(o.d[k]).slice(0, k === "tuner" ? 4000 : 80);
    return { name: String(o.n || "Shared look").slice(0, 40), d };
  } catch (e) {
    return null;
  }
}

function swatch(d) {
  const a = d.theme || "#60a5fa";
  const bg = d.mode === "gradient" && d.g1 && d.g2 ? `linear-gradient(135deg, ${d.g1}, ${d.g2})` : d.mode === "rainbow" ? "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" : a;
  return `<span class="look-dot" style="background:${esc(bg)}"></span>`;
}

function render() {
  const box = $("looksBody");
  if (!box) return;
  const list = all();
  box.innerHTML = `
    <div class="look-list">
      ${
        list.length
          ? list
              .map(
                (l, i) => `
        <div class="look-row">
          <button class="look-apply" data-i="${i}" title="Use this look">${swatch(l.d)}<span>${esc(l.name)}</span><small>${esc((l.d.viz || "").toUpperCase())}${l.d.viz === "liquid" ? " " + esc((l.d.ver || "v2").toUpperCase()) : ""}</small></button>
          <button class="look-icon" data-share="${i}" title="Copy share code"><i class="fa-solid fa-share-nodes"></i></button>
          <button class="look-icon look-del" data-del="${i}" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>`,
              )
              .join("")
          : `<div class="look-empty">No saved looks yet</div>`
      }
    </div>
    <button class="set-btn set-btn-accent" id="lookSave"><i class="fa-solid fa-plus"></i> Save current look</button>
    <div class="jam-join look-import">
      <input id="lookCode" placeholder="Paste a look code" autocomplete="off" spellcheck="false">
      <button class="set-btn" id="lookAdd">Add</button>
    </div>`;
  box.querySelectorAll("[data-i]").forEach((b) =>
    b.addEventListener("click", () => {
      const l = all()[+b.dataset.i];
      if (!l) return;
      apply(l.d);
      toast(`Look "${l.name}" on 🎨`);
    }),
  );
  box.querySelectorAll("[data-share]").forEach((b) =>
    b.addEventListener("click", () => {
      const l = all()[+b.dataset.share];
      if (!l) return;
      const code = toCode(l);
      (navigator.clipboard ? navigator.clipboard.writeText(code) : Promise.reject())
        .then(() => toast("Look code copied - send it to a friend"))
        .catch(() => prompt("Copy this look code:", code));
    }),
  );
  box.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => {
      const a = all();
      const l = a[+b.dataset.del];
      if (!l || !confirm(`Delete the look "${l.name}"?`)) return;
      a.splice(+b.dataset.del, 1);
      saveAll(a);
      render();
    }),
  );
  $("lookSave").onclick = () => {
    const a = all();
    const name = (prompt("Name this look:", `Look ${a.length + 1}`) || "").trim().slice(0, 40);
    if (!name) return;
    a.push({ name, d: current() });
    saveAll(a);
    render();
    toast(`Saved "${name}"`);
  };
  const add = () => {
    const l = fromCode($("lookCode").value);
    if (!l) return toast("That code doesn't look right");
    const a = all();
    a.push(l);
    saveAll(a);
    render();
    apply(l.d);
    toast(`Added + using "${l.name}" 🎨`);
  };
  $("lookAdd").onclick = add;
  $("lookCode").onkeydown = (e) => e.key === "Enter" && add();
}

const det = $("looksDetails");
if (det) det.addEventListener("toggle", () => det.open && render());
render();

window.looks = { current, apply, toCode, fromCode, all, render };
