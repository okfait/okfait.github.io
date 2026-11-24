// okMUSIC "Send songs to your phone" (v2.25.0)
//
// PC: Library → Sync & Backup → Send songs to your phone → a QR code shows up.
// Phone: scan it with the camera → okMUSIC opens and the songs come straight from the PC
// (device to device, same connection as Jam / Phone remote - nothing is uploaded anywhere).
// Names, covers, folders, YouTube ids, beat/speed edits and per-song sound settings come too.
// Songs the phone already has are skipped, so you can send again after adding new ones.
//
// The old "sync link" only sent song NAMES and made the phone download everything again.

import { host, join, cleanCode, qrSvg, shareLink } from "./link.js?v=2.29.0";

const $ = (id) => document.getElementById(id);
const toast = (m, ms) => window.ui && window.ui.showToast(m, ms);
const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const KIND = "libsync";
const keyOf = (name, size) => `${name}|${size}`;
// everything about a song except the audio itself
const EXTRA = ["art", "yt", "lyrics", "beatSignals", "speedPoints", "kickMap", "bassVal", "reverbVal", "baseSpeed", "xtremeOn", "artChecked"];

const S = {
  role: null, // "pc" | "phone"
  room: null,
  code: "",
  busy: "",
  // progress shown in the sheet
  total: 0,
  done: 0,
  skipped: 0,
  current: "",
  pct: 0,
  finished: false,
  error: "",
  wake: null,
};

const extOf = (mime) => {
  mime = String(mime || "");
  if (/mpeg|mp3/.test(mime)) return "mp3";
  if (/mp4|m4a|aac/.test(mime)) return "m4a";
  if (/webm/.test(mime)) return "webm";
  if (/ogg|opus/.test(mime)) return "ogg";
  if (/wav/.test(mime)) return "wav";
  if (/flac/.test(mime)) return "flac";
  return "mp3";
};

// ================================================================== PC side
async function sendAll(L, have) {
  const P = window.player;
  const songs = (P.songs || []).filter((s) => s.blob && !s.suggested);
  const plan = songs.map((s) => ({ id: s.id, k: keyOf(s.name, s.blob.size) }));
  const todo = songs.filter((s) => !have.has(keyOf(s.name, s.blob.size)));
  S.total = todo.length;
  S.done = 0;
  S.skipped = songs.length - todo.length;
  S.finished = false;
  S.error = "";
  L.send({ t: "plan", songs: plan, total: todo.length, skipped: S.skipped });
  render();
  for (const s of todo) {
    if (!L.open) throw new Error("the phone disconnected");
    S.current = s.name;
    S.pct = 0;
    render();
    const meta = { id: s.id, name: s.name };
    for (const k of EXTRA) {
      const v = s[k];
      if (v === undefined || v === null) continue;
      if (k === "art" && (typeof v !== "string" || v.length > 700000)) continue; // only small cover pictures
      meta[k] = v;
    }
    const saved = new Promise((ok, bad) => {
      L.waitSaved = { id: s.id, ok, bad };
    });
    await L.sendFile(meta, s.blob, (p) => {
      S.pct = p;
      paintProgress();
    });
    await saved; // phone stored it - next one (keeps the phone's memory low)
    S.done++;
    paintProgress();
  }
  L.send({ t: "struct", structure: window.libraryMgr.structure });
  L.send({ t: "done" });
  S.finished = true;
  S.current = "";
  render();
  toast(S.total ? `Sent ${S.total} song${S.total > 1 ? "s" : ""} to your phone 📱` : "Your phone already has all your songs");
}

function pcMsg(m, L) {
  if (m.t === "have") {
    L.sending = sendAll(L, new Set(m.keys || [])).catch((e) => {
      S.error = e.message || String(e);
      render();
    });
    return;
  }
  if (m.t === "saved" && L.waitSaved && L.waitSaved.id === m.id) {
    L.waitSaved.ok();
    L.waitSaved = null;
    return;
  }
  if (m.t === "fail" && L.waitSaved) {
    L.waitSaved.bad(new Error(m.msg || "the phone couldn't save a song"));
    L.waitSaved = null;
  }
}

async function startPc() {
  if (S.busy) return;
  if (!window.player.songs || !window.player.songs.length) return toast("Your library is empty - nothing to send");
  S.busy = "Making your QR code...";
  render();
  try {
    S.room = await host(KIND, {
      onJoin: () => {
        toast("Phone connected 📱");
        render();
      },
      onLeave: (L) => {
        if (L.waitSaved) L.waitSaved.bad(new Error("the phone disconnected"));
        if (!S.finished && S.total) toast("Phone disconnected");
        render();
      },
      onMsg: pcMsg,
    });
    S.role = "pc";
    S.code = S.room.code;
  } catch (e) {
    toast("Couldn't start: " + (e.message || e));
  }
  S.busy = "";
  render();
}

function stopPc() {
  if (S.room) S.room.close();
  S.room = null;
  S.role = null;
  S.total = S.done = S.skipped = 0;
  S.finished = false;
  S.error = "";
  render();
}

// ================================================================== phone side
const phone = {
  have: new Map(), // key -> phone song id
  idMap: new Map(), // pc song id -> phone song id
  plan: [],
  saving: Promise.resolve(),
};

async function saveSong(meta, blob, L) {
  const P = window.player;
  const name = String(meta.name || "Song");
  const safe = name.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 120) || "Song";
  const file = new File([blob], `${safe}.${extOf(blob.type)}`, { type: blob.type || "audio/mpeg" });
  try {
    const newId = await P.db.add(file, { beatSignals: meta.beatSignals || [], speedPoints: meta.speedPoints });
    const upd = { name, isNew: true };
    for (const k of EXTRA) if (meta[k] !== undefined && k !== "beatSignals" && k !== "speedPoints") upd[k] = meta[k];
    await P.db.update(newId, upd);
    phone.idMap.set(meta.id, newId);
    phone.have.set(keyOf(name, blob.size), newId);
    S.done++;
    L.send({ t: "saved", id: meta.id });
  } catch (e) {
    const full = e && /quota/i.test((e.name || "") + (e.message || ""));
    const msg = full ? "your phone's storage for okMUSIC is full" : "couldn't save " + name;
    S.error = msg;
    L.send({ t: "fail", id: meta.id, msg });
  }
  render();
  clearTimeout(phone.libTimer);
  phone.libTimer = setTimeout(() => P.loadLib(), 1200); // show songs as they arrive, not after every single one
}

// PC folders -> phone: only the NEW songs get placed; songs you already had stay where they are
function mergeStructure(pcStruct) {
  const lm = window.libraryMgr;
  const newIds = new Set();
  for (const [pcId, phId] of phone.idMap) if (phone.received.has(pcId)) newIds.add(phId);
  const placed = new Set();
  const mapItems = (items) => {
    const out = [];
    for (const it of items || []) {
      if (it.type === "song") {
        const id = phone.idMap.get(it.id);
        if (id && newIds.has(id) && !placed.has(id)) {
          placed.add(id);
          out.push({ type: "song", id });
        }
      } else if (it.type === "folder") {
        const sub = mapItems(it.items);
        if (sub.length) out.push({ ...it, id: crypto.randomUUID(), items: sub });
      }
    }
    return out;
  };
  const mapped = mapItems(pcStruct);
  // take the new songs out of wherever loadLib dropped them (end of the list)
  const strip = (items) => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].type === "song" && placed.has(items[i].id)) items.splice(i, 1);
      else if (items[i].type === "folder") strip(items[i].items);
    }
  };
  strip(lm.structure);
  for (const it of mapped) {
    if (it.type === "folder") {
      const same = lm.structure.find((f) => f.type === "folder" && f.name === it.name);
      if (same) {
        same.items.push(...it.items);
        continue;
      }
    }
    lm.structure.push(it);
  }
  lm.save();
}

function phoneMsg(m, L) {
  if (m.t === "plan") {
    phone.plan = m.songs || [];
    S.total = m.total || 0;
    S.skipped = m.skipped || 0;
    S.done = 0;
    // songs you already had: remember which phone song they are (for the folders)
    for (const p of phone.plan) if (phone.have.has(p.k)) phone.idMap.set(p.id, phone.have.get(p.k));
    render();
    return;
  }
  if (m.t === "fileStart") {
    S.current = m.meta.name || "";
    S.pct = 0;
    render();
    return;
  }
  if (m.t === "fileProgress") {
    S.pct = m.pct;
    paintProgress();
    return;
  }
  if (m.t === "fileDone") {
    phone.received.add(m.meta.id);
    phone.saving = phone.saving.then(() => saveSong(m.meta, m.blob, L));
    return;
  }
  if (m.t === "fileFailed") {
    S.error = "a song got cut off on the way - send again to finish";
    render();
    return;
  }
  if (m.t === "struct") {
    phone.struct = m.structure;
    return;
  }
  if (m.t === "done") {
    phone.saving.then(async () => {
      try {
        await window.player.loadLib();
        if (phone.struct) mergeStructure(phone.struct);
        await window.player.loadLib();
      } catch (e) {
        console.warn("lib-send: folders", e);
      }
      if (window.ltStorage) window.ltStorage.afterAdd();
      S.finished = true;
      S.current = "";
      render();
      toast(S.done ? `Got ${S.done} song${S.done > 1 ? "s" : ""} from your PC 🎶` : "You already had every song 👍", 4000);
      try {
        if (S.wake) S.wake.release();
      } catch (e) {}
      setTimeout(() => S.room && S.room.close(), 1500);
    });
  }
}

async function startPhone(code) {
  code = cleanCode(code);
  if (!code) return toast("Type the code from your PC");
  if (S.busy || S.role === "phone") return;
  S.busy = "Connecting to your PC...";
  render();
  try {
    const P = window.player;
    await P.db.open().catch(() => {});
    const mine = await P.db.getAll();
    phone.have = new Map(mine.filter((s) => s.blob).map((s) => [keyOf(s.name, s.blob.size), s.id]));
    phone.idMap = new Map();
    phone.received = new Set();
    phone.struct = null;
    S.total = S.done = S.skipped = 0;
    S.finished = false;
    S.error = "";
    S.room = await join(KIND, code, {
      onMsg: phoneMsg,
      onDrop: () => {
        if (!S.finished) {
          S.error = "lost the connection - keep this screen open, then scan again (songs you got stay)";
          render();
        }
      },
    });
    S.role = "phone";
    S.code = code;
    try {
      if ("wakeLock" in navigator) S.wake = await navigator.wakeLock.request("screen");
    } catch (e) {}
    S.room.link.send({ t: "have", keys: [...phone.have.keys()] });
    const u = new URL(location.href);
    u.searchParams.delete("libsync");
    history.replaceState(null, "", u);
  } catch (e) {
    toast(e.message || "Couldn't connect");
    S.role = null;
  }
  S.busy = "";
  render();
}

// ================================================================== sheet
function progressHtml(who) {
  const n = S.total;
  if (S.finished)
    return `<div class="ls-done"><i class="fa-solid fa-circle-check"></i> ${
      n ? `${who === "pc" ? "Sent" : "Got"} ${S.done} song${S.done === 1 ? "" : "s"}` : "Already had every song"
    }${S.skipped ? ` <small>(${S.skipped} already on the phone)</small>` : ""}</div>`;
  if (!n && !S.current) return "";
  const overall = n ? Math.round(((S.done + S.pct / 100) / n) * 100) : 0;
  return `
    <div class="ls-prog">
      <div class="ls-prog-top"><span id="lsCount">${Math.min(S.done + 1, n)} / ${n}</span><span id="lsPct">${overall}%</span></div>
      <div class="ls-bar"><i id="lsBar" style="width:${overall}%"></i></div>
      <div class="ls-name" id="lsName">${esc(S.current)}</div>
      ${S.skipped ? `<small class="ls-skip">${S.skipped} song${S.skipped > 1 ? "s" : ""} already on the phone - skipped</small>` : ""}
    </div>`;
}
// progress updates many times a second: only touch the numbers, not the whole sheet
function paintProgress() {
  const n = S.total;
  if (!n || !$("lsBar")) return render();
  const overall = Math.round(((S.done + S.pct / 100) / n) * 100);
  $("lsBar").style.width = overall + "%";
  $("lsPct").textContent = overall + "%";
  $("lsCount").textContent = `${Math.min(S.done + 1, n)} / ${n}`;
}

function render() {
  const box = $("lsBody");
  if (!box) return;
  const err = S.error ? `<div class="ls-err"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(S.error)}</div>` : "";
  if (S.busy) {
    box.innerHTML = `<div class="jam-wait"><i class="fa-solid fa-spinner fa-spin"></i> ${esc(S.busy)}</div>`;
    return;
  }
  if (S.role === "pc") {
    const link = shareLink("libsync", S.code);
    const n = S.room ? S.room.links.size : 0;
    const count = (window.player.songs || []).length;
    box.innerHTML = `
      <div class="jam-code-wrap">
        <div class="jam-qr" id="lsQr"></div>
        <div class="jam-code-side">
          <small>Code</small>
          <div class="jam-code">${esc(S.code)}</div>
          <p>Scan this with your phone's camera. Your ${count} song${count === 1 ? "" : "s"} go straight to the phone with names, covers and folders.</p>
        </div>
      </div>
      <div class="jam-people"><i class="fa-solid fa-mobile-screen"></i> ${n ? "Phone connected" : "Waiting for your phone..."}</div>
      ${progressHtml("pc")}${err}
      <p class="jam-hint">Keep this tab and the phone screen open until it's done. Songs the phone already has get skipped.</p>
      <button class="set-btn jam-leave" id="lsStop"><i class="fa-solid fa-xmark"></i> ${S.finished ? "Done" : "Stop"}</button>`;
    qrSvg(link).then((svg) => $("lsQr") && ($("lsQr").innerHTML = svg)).catch(() => {});
    $("lsStop").onclick = () => {
      stopPc();
      toggleSheet(false);
    };
    return;
  }
  if (S.role === "phone") {
    box.innerHTML = `
      <div class="jam-people"><i class="fa-solid fa-laptop"></i> Connected to your PC</div>
      ${progressHtml("phone") || `<div class="jam-wait"><i class="fa-solid fa-spinner fa-spin"></i> Getting the song list...</div>`}${err}
      <p class="jam-hint">${S.finished ? "All done - they're in your library." : "Keep this screen open until it's done (locking the phone stops it)."}</p>
      ${S.finished ? `<button class="set-btn set-btn-accent" id="lsClose">Open my library</button>` : ""}`;
    if ($("lsClose"))
      $("lsClose").onclick = () => {
        toggleSheet(false);
        S.role = null;
        const lib = $("libraryPanel");
        if (lib && !lib.classList.contains("open") && window.ui && window.ui.toggleLibrary) window.ui.toggleLibrary();
      };
    return;
  }
  const isPhone = matchMedia("(pointer: coarse)").matches || innerWidth < 800;
  const joinBox = `
    <div class="jam-join">
      <input id="lsCodeIn" maxlength="8" placeholder="CODE" autocomplete="off" autocapitalize="characters">
      <button class="set-btn" id="lsJoin">Get songs</button>
    </div>`;
  const hostBtn = `<button class="set-btn ${isPhone ? "" : "set-btn-accent"}" id="lsHost"><i class="fa-solid fa-qrcode"></i> Show QR code (send from this device)</button>`;
  box.innerHTML =
    err +
    (isPhone
      ? `<p class="jam-hint">On your PC: Library → Sync &amp; Backup → Send songs to your phone, then scan the QR with your camera. Or type the code here:</p>
       ${joinBox}<div class="jam-or"><span>or</span></div>${hostBtn}`
      : `<p class="jam-hint">Shows a QR code. Scan it with your phone and all your songs get copied to the phone's okMUSIC, with names, covers and folders.</p>
       ${hostBtn}<div class="jam-or"><span>or get songs from another device</span></div>${joinBox}`);
  $("lsHost").onclick = startPc;
  $("lsJoin").onclick = () => startPhone($("lsCodeIn").value);
  $("lsCodeIn").onkeydown = (e) => e.key === "Enter" && startPhone(e.target.value);
}

function toggleSheet(force) {
  if (!$("lsSheet")) {
    const el = document.createElement("div");
    el.id = "lsSheet";
    el.className = "jam-sheet";
    el.innerHTML = `
      <div class="jam-card">
        <div class="jam-head">
          <div class="jam-title"><i class="fa-solid fa-mobile-screen-button"></i> Songs to your phone</div>
          <button class="tuner-icon-btn" id="lsCloseX" title="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div id="lsBody"></div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener("click", (e) => e.target === el && toggleSheet(false));
    $("lsCloseX").onclick = () => toggleSheet(false);
  }
  const el = $("lsSheet");
  const open = force === undefined ? !el.classList.contains("open") : force;
  el.classList.toggle("open", open);
  if (open) render();
}

// one tap from the menu on a PC = QR right away
function openSend() {
  toggleSheet(true);
  const isPhone = matchMedia("(pointer: coarse)").matches || innerWidth < 800;
  if (!S.role && !isPhone) startPc();
}

window.libSend = { open: openSend, toggle: toggleSheet, _state: S };

// opened from the QR code (…?libsync=CODE): start getting songs right away
const pre = new URLSearchParams(location.search).get("libsync");
if (pre) {
  setTimeout(() => {
    toggleSheet(true);
    startPhone(pre);
  }, 600);
}
