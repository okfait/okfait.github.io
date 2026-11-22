// okMUSIC v3 "Add Songs": search any song, or grab a whole Spotify / YouTube playlist,
// and it lands in your library (playlists get their own folder).
//
// The downloading is done by the okMUSIC helper on your PC (helper/okmusic-helper.py) if it's
// running, otherwise by free public YouTube mirrors straight from the browser (web-yt.js).

// v2.16.0: or the same helper running online (bot-hosting.net) = nothing to install.
// Order: the PC helper if it's running (fastest, never blocked), else the online server.
const LOCAL = "http://127.0.0.1:47823";
// v2.17.0: the okMUSIC server on bot-hosting only reads Spotify links now (YouTube blocks its downloads);
// the songs themselves come from web-yt.js (free public YouTube mirrors) when the PC helper is off
const SERVER_DEFAULT = "https://h76s92g0n5.apps.bot-hosting.cloud";
function serverUrl() {
  let u = "";
  try {
    u = localStorage.getItem("okmusic_server") || "";
  } catch (e) {}
  return (u || SERVER_DEFAULT).trim().replace(/\/+$/, "");
}
let HELPER = LOCAL;
import * as web from "./web-yt.js?v=2.22.0";
const PARALLEL = 2; // songs downloading at the same time
const $ = (id) => document.getElementById(id);
const toast = (m) => window.ui && window.ui.showToast(m);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

const state = {
  helperOk: null,
  tab: "search",
  busy: false,
  list: null, // { title, image, tracks: [{title, artist, duration, spotify?, youtube?, art?, st, err}] }
  stop: false,
  pollTimer: null,
};

// ------------------------------------------------------------------ helper calls
async function helperFetch(path, { timeout = 0, raw = false } = {}) {
  if (state.where === "web") return web.fetchLike(path, { raw, server: serverUrl() });
  const ctl = new AbortController();
  const t = timeout ? setTimeout(() => ctl.abort(), timeout) : null;
  try {
    const res = await fetch(HELPER + path, { signal: ctl.signal });
    if (raw) {
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "helper error " + res.status);
      }
      return res;
    }
    const j = await res.json();
    if (!res.ok || j.error) throw new Error(j.error || "helper error " + res.status);
    return j;
  } finally {
    if (t) clearTimeout(t);
  }
}

async function tryPing(base, timeout) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const j = await (await fetch(base + "/ping", { signal: ctl.signal })).json();
    return j && j.ok ? j : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function pingHelper() {
  // 1. the PC helper (fastest, most reliable) 2. no-install mode (free public YouTube mirrors)
  const j = await tryPing(LOCAL, 1500);
  let ok = !!j;
  if (j) {
    HELPER = LOCAL;
    state.where = "pc";
    state.helperOld = !j.version || j.version < "1.1.0";
  } else {
    ok = await web.ping();
    state.where = ok ? "web" : null;
    state.helperOld = false;
  }
  setHelper(ok);
  return state.helperOk;
}

function setHelper(ok) {
  const was = state.helperOk;
  state.helperOk = ok;
  const st = $("finderStatus");
  if (!st) return;
  st.className = "finder-status " + (ok ? "ok" : "bad");
  if (ok) $("finderSetup").hidden = true;
  if (!ok && was === null) $("finderSetup").hidden = false; // first look: show the steps
  st.querySelector("span.txt").textContent = ok
    ? state.where === "web"
      ? "Ready, no install needed (free YouTube servers)"
      : state.helperOld
        ? "Helper connected (old version: re-download it for previews)"
        : "PC helper connected"
    : "The free YouTube servers aren't answering, try again in a bit (or use the PC helper)";
  const showBtn = !ok || state.where === "web";
  st.querySelector("button").textContent = !showBtn ? "" : !$("finderSetup").hidden ? "Hide" : ok ? "Faster?" : "Options";
  st.querySelector("button").style.display = showBtn ? "" : "none";
  if (ok && was === false) toast(state.where === "web" ? "Add Songs is back 🎉" : "Helper connected 🎉");
  clearInterval(state.pollTimer);
  // in no-install mode keep checking now and then, so starting the PC helper switches to it
  if (isOpen() && (!ok || state.where === "web")) state.pollTimer = setInterval(pingHelper, ok ? 15000 : 5000);
}

// ------------------------------------------------------------------ library helpers
function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\((official|lyric|lyrics|audio|video|visuali[sz]er|remaster)[^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\b(feat|ft|featuring)\b.*$/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function firstArtist(a) {
  return (a || "").split(/,|&| x | feat/i)[0].trim();
}
function songName(t) {
  return t.artist ? `${firstArtist(t.artist)} - ${t.title}` : t.title;
}
function haveSong(t) {
  const title = norm(t.title);
  const artist = norm(firstArtist(t.artist));
  if (!title) return false;
  return (window.player.songs || []).some((s) => {
    const n = norm(s.name);
    return n.includes(title) && (!artist || n.includes(artist));
  });
}
function topFolders() {
  return (window.libraryMgr.structure || []).filter((x) => x.type === "folder");
}
function folderByName(name, create) {
  let f = topFolders().find((x) => x.name === name);
  if (!f && create) {
    f = { type: "folder", id: crypto.randomUUID(), name, items: [], isOpen: true, color: "#1db954" };
    window.libraryMgr.structure.unshift(f);
  }
  return f;
}
let reloadTimer = null;
function refreshLibrarySoon() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => window.player.loadLib(), 600);
}

async function toDataUrl(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > 400000) return null;
    return await new Promise((ok) => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.onerror = () => ok(null);
      r.readAsDataURL(blob);
    });
  } catch (e) {
    return null;
  }
}

// Downloads one song through the helper and saves it. Returns the new song id.
async function grab({ id, query, dur, name, art, folder, meta }) {
  const qs = id
    ? `id=${encodeURIComponent(id)}&title=${encodeURIComponent(name || "")}`
    : `q=${encodeURIComponent(query)}&dur=${dur || ""}&title=${encodeURIComponent(name || query)}`;
  const res = await helperFetch("/download?" + qs, { raw: true });
  const vid = res.headers.get("X-Video-Id") || id;
  const ext = res.headers.get("X-Ext") || "m4a";
  const title = name || decodeURIComponent(res.headers.get("X-Title") || "") || "Song";
  const blob = await res.blob();
  if (blob.size < 20000) throw new Error("download came back empty");
  const safe = title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  const file = new File([blob], `${safe}.${ext}`, { type: blob.type || "audio/mp4" });
  const songId = await window.player.db.add(file);
  const cover = (art && (await toDataUrl(art))) || (vid && (await toDataUrl(state.where === "web" ? `https://i.ytimg.com/vi/${encodeURIComponent(vid)}/mqdefault.jpg` : `${HELPER}/thumb?id=${encodeURIComponent(vid)}`)));
  // remember which video it was (v2.19.0) so a name can always be fixed later
  await window.player.db.update(songId, cover ? { art: cover, yt: vid || null } : { yt: vid || null }).catch(() => {});
  if (folder) {
    folderByName(folder, true).items.push({ type: "song", id: songId });
    window.libraryMgr.save();
  }
  refreshLibrarySoon();
  // look for lyrics right away so the lyrics button is ready when you play it
  if (window.lyrics && window.lyrics.prefetch) window.lyrics.prefetch(songId, meta || { name: title, duration: dur }).catch(() => {});
  if (window.ltStorage) window.ltStorage.afterAdd && window.ltStorage.afterAdd();
  return songId;
}

// ------------------------------------------------------------------ previews
const pv = { audio: null, key: null, btn: null, row: null };
function setPvBtn(btn, mode) {
  if (!btn) return;
  btn.classList.toggle("on", mode !== "idle");
  btn.innerHTML = mode === "load" ? `<i class="fa-solid fa-spinner fa-spin"></i>` : mode === "play" ? `<i class="fa-solid fa-pause"></i>` : `<i class="fa-solid fa-play"></i>`;
}
function stopPreview() {
  if (pv.audio) {
    pv.audio.pause();
    pv.audio.removeAttribute("src");
    pv.audio.load();
  }
  setPvBtn(pv.btn, "idle");
  if (pv.row) pv.row.classList.remove("previewing");
  pv.audio = pv.key = pv.btn = pv.row = null;
}
// getId: () => Promise<youtube id>
async function togglePreview(key, getId, btn) {
  if (pv.key === key) return stopPreview();
  stopPreview();
  if (!state.helperOk && !(await pingHelper())) return needHelper();
  if (state.helperOld) return toast("Previews need the new helper: download it again (steps at the top)");
  pv.key = key;
  pv.btn = btn;
  pv.row = btn.closest(".f-item");
  if (pv.row) pv.row.classList.add("previewing");
  setPvBtn(btn, "load");
  try {
    const id = await getId();
    if (pv.key !== key) return; // something else got clicked meanwhile
    // pause the main player so they don't play on top of each other
    const main = window.audioSys && window.audioSys.audio;
    if (main && !main.paused) {
      main.pause();
      window.ui.updatePlayBtn && window.ui.updatePlayBtn(false);
    }
    const src = state.where === "web" ? await web.previewUrl(id) : `${HELPER}/preview?id=${encodeURIComponent(id)}`;
    if (pv.key !== key) return;
    const a = new Audio(src);
    const g = window.audioSys && window.audioSys.gain;
    a.volume = g ? Math.min(1, g.gain.value) : 0.8;
    pv.audio = a;
    a.addEventListener("loadedmetadata", () => {
      // skip the intro: start around the first chorus-ish part
      if (a.duration > 90) a.currentTime = Math.min(45, a.duration * 0.28);
    }, { once: true });
    a.addEventListener("playing", () => pv.audio === a && setPvBtn(btn, "play"));
    a.addEventListener("waiting", () => pv.audio === a && setPvBtn(btn, "load"));
    a.addEventListener("ended", () => pv.audio === a && stopPreview());
    a.addEventListener("error", () => {
      if (pv.audio !== a) return;
      stopPreview();
      toast("Couldn't play that preview");
    });
    await a.play();
  } catch (e) {
    if (pv.key === key) {
      stopPreview();
      toast("Preview failed: " + e.message);
    }
  }
}

// ------------------------------------------------------------------ UI
function isOpen() {
  return $("finderSheet") && $("finderSheet").classList.contains("open");
}

function build() {
  if ($("finderSheet")) return;
  const back = document.createElement("div");
  back.id = "finderBackdrop";
  back.className = "finder-backdrop";
  back.addEventListener("click", close);
  const el = document.createElement("div");
  el.id = "finderSheet";
  el.className = "finder-sheet";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Add songs");
  el.innerHTML = `
    <div class="finder-head">
      <h3>Add Songs</h3>
      <button type="button" class="tuner-icon-btn" id="finderClose" title="Close"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="finder-status" id="finderStatus"><span class="dot"></span><span class="txt">Getting ready...</span><button type="button"></button></div>
    <div class="finder-setup" id="finderSetup" hidden>
      <b>Works without installing anything.</b> <span style="opacity:.7">Songs come from free public YouTube servers: sometimes slow, sometimes down for a bit.</span>
      <b style="display:block;margin-top:10px">Want it faster + always working? Optional PC helper:</b>
      <ol>
        <li>Download <a href="helper/okmusic-helper.py" download>okmusic-helper.py</a> and <a href="helper/Start%20okMUSIC%20Helper.bat" download>Start okMUSIC Helper.bat</a>, put both in the same folder.</li>
        <li>Double-click <b>Start okMUSIC Helper.bat</b>. A black window opens, leave it open. (Needs <a href="https://www.python.org/downloads/" target="_blank" rel="noopener">Python</a>, tick "Add to PATH" when installing.)</li>
        <li>Come back here, it connects by itself. If the browser asks to <i>access devices on your network</i>, press Allow.</li>
      </ol>
      <label class="finder-server">
        <b>okMUSIC server</b> <span style="opacity:.7">(reads Spotify links when the PC helper is off)</span>
        <input class="finder-input" id="finderServer" placeholder="https://....apps.bot-hosting.cloud" autocomplete="off" spellcheck="false">
      </label>
    </div>
    <div class="seg finder-tabs" id="finderTabs">
      <button type="button" data-tab="search" class="active"><i class="fa-solid fa-magnifying-glass"></i> Search</button>
      <button type="button" data-tab="playlist"><i class="fa-solid fa-list"></i> Playlist</button>
    </div>
    <div class="finder-input-row">
      <input class="finder-input" id="finderInput" placeholder="Song name, artist..." autocomplete="off" spellcheck="false">
      <button type="button" class="finder-go" id="finderGo">Search</button>
    </div>
    <div class="finder-folder" id="finderFolderRow">
      <span>Save to</span>
      <select id="finderFolder" class="ios-native-select" data-ios-select></select>
    </div>
    <div class="finder-body custom-scrollbar" id="finderBody"></div>
    <div class="finder-foot" id="finderFoot" hidden></div>`;
  document.body.append(back, el);

  $("finderClose").addEventListener("click", close);
  $("finderStatus").querySelector("button").addEventListener("click", () => {
    $("finderSetup").hidden = !$("finderSetup").hidden;
    setHelper(state.helperOk);
  });
  const srvIn = $("finderServer");
  srvIn.value = serverUrl();
  srvIn.addEventListener("keydown", (e) => e.stopPropagation());
  srvIn.addEventListener("change", () => {
    let v = srvIn.value.trim();
    if (v && !/^https?:\/\//i.test(v)) v = "https://" + v;
    try {
      if (v) localStorage.setItem("okmusic_server", v);
      else localStorage.removeItem("okmusic_server");
    } catch (e) {}
    srvIn.value = v;
    pingHelper();
  });
  $("finderTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) setTab(b.dataset.tab);
  });
  $("finderGo").addEventListener("click", go);
  $("finderInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
    e.stopPropagation(); // don't trigger player hotkeys (space = pause) while typing
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}

function fillFolders() {
  const sel = $("finderFolder");
  const keep = sel.value;
  sel.innerHTML = `<option value="">Library (no folder)</option>` + topFolders().map((f) => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  // turn it into the same iOS dropdown as the settings (once), then refresh its items
  const wrap = sel.nextElementSibling;
  if (wrap && wrap.classList.contains("ios-select")) wrap.remove();
  delete sel.dataset.enhanced;
  if (window.uiv3 && window.uiv3.enhanceSelect) window.uiv3.enhanceSelect(sel);
}

function setTab(tab) {
  stopPreview();
  state.tab = tab;
  document.querySelectorAll("#finderTabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const input = $("finderInput");
  input.value = "";
  if (tab === "search") {
    input.placeholder = "Song name, artist, or a YouTube link";
    $("finderGo").textContent = "Search";
    $("finderFolderRow").hidden = false;
    $("finderFoot").hidden = true;
    $("finderBody").innerHTML = `<div class="finder-empty"><i class="fa-solid fa-magnifying-glass"></i>Type a song and press Search.<br>Hit <b>+</b> on the right one and it's in your library.</div>`;
  } else {
    input.placeholder = "Paste a Spotify or YouTube playlist link";
    $("finderGo").textContent = "Load";
    $("finderFolderRow").hidden = true;
    if (state.list) renderList();
    else showMyPlaylists();
  }
  setTimeout(() => input.focus(), 50);
}

function open(tab) {
  build();
  fillFolders();
  $("finderBackdrop").classList.add("open");
  $("finderSheet").classList.add("open");
  setTab(tab || state.tab);
  pingHelper();
}
function close() {
  if (!$("finderSheet")) return;
  $("finderBackdrop").classList.remove("open");
  $("finderSheet").classList.remove("open");
  clearInterval(state.pollTimer);
  stopPreview();
}

function needHelper() {
  if (state.helperOk) return true;
  $("finderSetup").hidden = false;
  setHelper(false);
  toast("Can't reach YouTube right now: the free servers are down. Try again in a bit, or start the PC helper");
  return false;
}

async function go() {
  const v = $("finderInput").value.trim();
  if (state.tab === "search") return doSearch(v);
  return loadList(v);
}

// ------------------------------------------------------------------ search tab
async function doSearch(q) {
  if (!q) return;
  if (!(await pingHelper()) && !needHelper()) return;
  const body = $("finderBody");
  const yt = q.match(/(?:youtu\.be\/|[?&]v=|shorts\/)([A-Za-z0-9_-]{11})/);
  // v2.19.2: a SONG link stays a song, even if it has a playlist / radio mix attached
  // (watch?v=...&list=RD... used to jump to the Playlist tab and load a never-ending mix)
  const listId = (q.match(/[?&]list=([A-Za-z0-9_-]+)/) || [])[1];
  if (/open\.spotify\.com\/(playlist|album)/.test(q) || (listId && !yt)) {
    setTab("playlist");
    $("finderInput").value = q;
    return loadList(q);
  }
  stopPreview();
  body.innerHTML = `<div class="finder-empty"><i class="fa-solid fa-spinner fa-spin"></i>Searching...</div>`;
  try {
    let results;
    if (yt) {
      // v2.19.0: the video's real title + channel (it used to say "from your link - YouTube video")
      const info = window.songNames ? await window.songNames.ytInfo(yt[1]) : {};
      results = [{ id: yt[1], title: info.title || "YouTube video", channel: info.channel || "", duration: info.duration || 0, thumb: `https://i.ytimg.com/vi/${yt[1]}/mqdefault.jpg` }];
    }
    else if (/open\.spotify\.com\/track/.test(q)) {
      const l = await helperFetch("/list?url=" + encodeURIComponent(q));
      const t = l.tracks[0];
      results = (await helperFetch(`/search?n=6&q=${encodeURIComponent(songName(t) + " audio")}`)).results;
    } else results = (await helperFetch(`/search?n=8&q=${encodeURIComponent(q)}`)).results;
    if (!results.length) {
      body.innerHTML = `<div class="finder-empty">Nothing found. Try the artist + song name.</div>`;
      return;
    }
    const isMix = listId && /^RD/.test(listId);
    const listBtn = yt && listId
      ? `<button type="button" class="set-btn finder-listbtn" id="finderWholeList"><i class="fa-solid fa-list"></i> ${isMix ? "Get the radio mix too (50 songs)" : "Get the whole playlist too"}</button>`
      : "";
    body.innerHTML = results
      .map(
        (r, i) => `
      <div class="f-item">
        <img class="f-thumb" src="${esc(r.thumb)}" alt="" loading="lazy">
        <div class="f-meta"><div class="f-title">${esc(r.title)}</div><div class="f-sub">${esc(r.channel)}${r.duration ? " · " + fmtDur(r.duration) : ""}</div></div>
        <button type="button" class="f-play" data-i="${i}" title="Listen first"><i class="fa-solid fa-play"></i></button>
        <button type="button" class="f-act" data-i="${i}" title="Add to library"><i class="fa-solid fa-plus"></i></button>
      </div>`,
      )
      .join("") + listBtn;
    if (listBtn)
      $("finderWholeList").addEventListener("click", () => {
        setTab("playlist");
        $("finderInput").value = q;
        loadList(q);
      });
    body.querySelectorAll(".f-play").forEach((b) =>
      b.addEventListener("click", () => {
        const r = results[+b.dataset.i];
        togglePreview("s:" + r.id, async () => r.id, b);
      }),
    );
    body.querySelectorAll(".f-act").forEach((b) =>
      b.addEventListener("click", async () => {
        if (b.classList.contains("busy") || b.classList.contains("done")) return;
        const r = results[+b.dataset.i];
        b.className = "f-act busy";
        b.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
        try {
          const folder = $("finderFolder").value || null;
          const nm = window.songNames ? window.songNames.niceName(r.title, r.channel) : r.title;
          await grab({ id: r.id, name: nm, folder });
          b.className = "f-act done";
          b.innerHTML = `<i class="fa-solid fa-check"></i>`;
          toast("Added: " + r.title);
        } catch (e) {
          b.className = "f-act fail";
          b.innerHTML = `<i class="fa-solid fa-rotate-right"></i>`;
          b.title = "Failed: " + e.message + " (click to retry)";
          toast("Couldn't get it: " + e.message);
        }
      }),
    );
  } catch (e) {
    body.innerHTML = `<div class="finder-empty"><i class="fa-solid fa-triangle-exclamation"></i>${esc(e.message)}</div>`;
  }
}

// ------------------------------------------------------------------ playlist tab
// turns Spotify's "no" into plain words + what to do about it
function spotifyWhy(e) {
  const m = String((e && (e.why || e.message)) || "");
  if (/not.*registered|user may not be|developer\.spotify|dashboard/i.test(m))
    return "Spotify blocked it: your account isn't on this app's allowed list. Fix: developer.spotify.com/dashboard → okMUSIC app → User Management → add your Spotify name + email, then try again.";
  if (/premium/i.test(m)) return "Spotify blocked it: the Spotify app needs its owner to have Premium (" + m + ").";
  if (e && e.status === 403) return "Spotify said no (" + m + "). Reconnecting won't fix this one.";
  return "Couldn't load your playlists (" + m + ").";
}

async function showMyPlaylists() {
  $("finderFoot").hidden = true;
  const body = $("finderBody");
  const sp = window.spotify;
  if (!sp || !sp.isConnected()) {
    body.innerHTML = `<div class="finder-empty"><i class="fa-brands fa-spotify" style="color:#1db954"></i>Paste a playlist link above.<br><span style="opacity:.7">Or connect Spotify in Settings to pick from your own playlists and Liked Songs.</span></div>`;
    return;
  }
  body.innerHTML = `<div class="finder-empty"><i class="fa-solid fa-spinner fa-spin"></i>Loading your Spotify...</div>`;
  try {
    const pls = await sp.getMyPlaylists();
    body.innerHTML =
      `<div class="finder-section-title">Your Spotify</div>
       <button type="button" class="finder-pl" data-liked="1"><span class="liked"><i class="fa-solid fa-heart"></i></span><div class="f-meta"><div class="f-title">Liked Songs</div><div class="f-sub">your saved songs</div></div></button>` +
      pls
        .map(
          (p) => `<button type="button" class="finder-pl" data-id="${esc(p.id)}"><img src="${esc(p.image)}" alt="" loading="lazy"><div class="f-meta"><div class="f-title">${esc(p.name)}</div><div class="f-sub">${p.count ? p.count + " songs" : "playlist"}</div></div></button>`,
        )
        .join("");
    body.querySelectorAll(".finder-pl").forEach((b) =>
      b.addEventListener("click", () => (b.dataset.liked ? loadList("liked") : loadList(`https://open.spotify.com/playlist/${b.dataset.id}`))),
    );
  } catch (e) {
    body.innerHTML =
      e.code === "scope"
        ? `<div class="finder-empty"><i class="fa-brands fa-spotify" style="color:#1db954"></i>Spotify needs one more OK to show your playlists.<br><button type="button" class="set-btn set-btn-spotify" style="margin-top:12px" onclick="window.spotify.login()">Reconnect Spotify</button><br><span style="opacity:.7">Or just paste a playlist link above.</span></div>`
        : `<div class="finder-empty"><i class="fa-brands fa-spotify" style="color:#1db954"></i>${esc(spotifyWhy(e))}<br><span style="opacity:.7">Pasting a playlist link above still works.</span></div>`;
  }
}

async function loadList(link) {
  if (!link) return showMyPlaylists();
  if (state.busy) return toast("Still downloading, hit Stop first");
  // v2.19.2: pressing Load again while it's still reading = ignored (two loads used to race and
  // the slower one wiped the list, so sometimes nothing showed)
  if (state.loading === link) return toast("Still reading that list, hang on");
  state.loading = link;
  const seq = (state.loadSeq = (state.loadSeq || 0) + 1);
  const body = $("finderBody");
  const t0 = Date.now();
  body.innerHTML = `<div class="finder-empty"><i class="fa-solid fa-spinner fa-spin"></i>Reading the song list... <span id="finderSecs"></span></div>`;
  const tick = setInterval(() => {
    const el = $("finderSecs");
    if (el) el.textContent = Math.round((Date.now() - t0) / 1000) + "s";
  }, 1000);
  $("finderFoot").hidden = true;
  try {
    let list = null;
    const sp = window.spotify;
    const spId = (link.match(/playlist\/([A-Za-z0-9]+)/) || [])[1];
    if (link === "liked") list = await sp.getLikedSongs();
    else if (spId && sp && sp.isConnected()) {
      try {
        list = await sp.getPlaylistFull(spId); // works for private playlists you own too
      } catch (e) {
        console.warn("Spotify API list failed, using helper", e);
      }
    }
    if (!list || !list.tracks.length) {
      if (!(await pingHelper()) && !needHelper()) {
        body.innerHTML = `<div class="finder-empty">Can't reach the free YouTube servers right now. Try Load again in a bit, or start the PC helper (Options at the top).</div>`;
        return;
      }
      list = await helperFetch("/list?url=" + encodeURIComponent(link));
    }
    if (seq !== state.loadSeq) return; // a newer load started meanwhile
    if (!list.tracks.length) throw new Error("that list is empty");
    list.tracks.forEach((t) => (t.st = haveSong(t) ? "have" : "todo"));
    state.list = list;
    if (state.tab === "playlist") renderList();
  } catch (e) {
    if (seq === state.loadSeq) body.innerHTML = `<div class="finder-empty"><i class="fa-solid fa-triangle-exclamation"></i>${esc(e.message)}</div>`;
  } finally {
    clearInterval(tick);
    if (seq === state.loadSeq) state.loading = null;
  }
}

const ICON = {
  todo: `<i class="fa-regular fa-circle"></i>`,
  have: `<i class="fa-solid fa-check" title="Already in your library"></i>`,
  busy: `<i class="fa-solid fa-spinner fa-spin"></i>`,
  done: `<i class="fa-solid fa-circle-check"></i>`,
  fail: `<i class="fa-solid fa-circle-exclamation"></i>`,
};

function renderList() {
  const l = state.list;
  const have = l.tracks.filter((t) => t.st === "have").length;
  $("finderBody").innerHTML = `
    <div class="finder-list-head">
      ${l.image ? `<img src="${esc(l.image)}" alt="">` : `<span class="finder-ph"><i class="fa-solid ${l.title === "Liked Songs" ? "fa-heart" : "fa-music"}"></i></span>`}
      <div class="f-meta"><div class="f-title">${esc(l.title)}</div><div class="f-sub" id="finderCount"></div></div>
    </div>
    <div class="finder-progress"><div id="finderBar"></div></div>
    <div id="finderRows">${l.tracks
      .map(
        (t, i) => `
      <div class="f-item" id="fr${i}">
        <span class="f-num">${i + 1}</span>
        <div class="f-meta"><div class="f-title">${esc(t.title)}</div><div class="f-sub">${esc(t.artist)}${t.duration ? " · " + fmtDur(t.duration) : ""}</div></div>
        <button type="button" class="f-play" data-i="${i}" title="Listen first"><i class="fa-solid fa-play"></i></button>
        <span class="f-state ${t.st}">${ICON[t.st]}</span>
      </div>`,
      )
      .join("")}</div>`;
  updateCount();
  $("finderRows").querySelectorAll(".f-play").forEach((b) =>
    b.addEventListener("click", () => {
      const t = l.tracks[+b.dataset.i];
      togglePreview("p:" + b.dataset.i + ":" + songName(t), async () => {
        if (!t.youtube) t.youtube = (await helperFetch(`/resolve?q=${encodeURIComponent(songName(t))}&dur=${t.duration || ""}`)).id;
        return t.youtube;
      }, b);
    }),
  );
  const foot = $("finderFoot");
  foot.hidden = false;
  foot.innerHTML = `
    <button type="button" class="set-btn" id="finderBack"><i class="fa-solid fa-chevron-left"></i></button>
    <button type="button" class="set-btn" id="finderMine" title="Match audio files you already have"><i class="fa-solid fa-folder-open"></i> My files</button>
    <button type="button" class="set-btn set-btn-accent" id="finderAll"></button>`;
  foot.querySelector("#finderBack").style.flex = "0 0 46px";
  $("finderBack").addEventListener("click", () => {
    if (state.busy) return toast("Stop the download first");
    state.list = null;
    showMyPlaylists();
  });
  $("finderMine").addEventListener("click", useMyFiles);
  $("finderAll").addEventListener("click", () => (state.busy ? (state.stop = true) : downloadAll()));
  updateFoot();
  if (have) toast(`${have} of these are already in your library, they'll be skipped`);
}

function updateCount() {
  const l = state.list;
  if (!l || !$("finderCount")) return;
  const c = (s) => l.tracks.filter((t) => t.st === s).length;
  const total = l.tracks.length;
  const done = c("done") + c("have");
  $("finderCount").textContent = `${total} songs · ${c("have")} already had · ${c("done")} added${c("fail") ? " · " + c("fail") + " failed" : ""}`;
  $("finderBar").style.width = (done / total) * 100 + "%";
}
function updateFoot() {
  const b = $("finderAll");
  if (!b || !state.list) return;
  const left = state.list.tracks.filter((t) => t.st === "todo" || t.st === "fail").length;
  if (state.busy) b.innerHTML = `<i class="fa-solid fa-stop"></i> Stop`;
  else if (!left) b.innerHTML = `<i class="fa-solid fa-check"></i> All in your library`;
  else b.innerHTML = `<i class="fa-solid fa-cloud-arrow-down"></i> Get ${left} song${left > 1 ? "s" : ""}`;
  b.disabled = !state.busy && !left;
}
function setRow(i, st, err) {
  const t = state.list.tracks[i];
  t.st = st;
  const row = $("fr" + i);
  if (!row) return;
  const s = row.querySelector(".f-state");
  s.className = "f-state " + st;
  s.innerHTML = ICON[st];
  const sub = row.querySelector(".f-sub");
  if (err) {
    sub.className = "f-sub err";
    sub.textContent = err;
  }
  if (st === "busy") row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  updateCount();
}

async function downloadAll() {
  if (!(await pingHelper()) && !needHelper()) return;
  const l = state.list;
  const folder = l.title || "Imported Playlist";
  const todo = l.tracks.map((t, i) => i).filter((i) => l.tracks[i].st === "todo" || l.tracks[i].st === "fail");
  state.busy = true;
  state.stop = false;
  updateFoot();
  let failsInRow = 0;
  const worker = async () => {
    while (todo.length && !state.stop) {
      const i = todo.shift();
      const t = l.tracks[i];
      if (haveSong(t)) {
        setRow(i, "have");
        continue;
      }
      setRow(i, "busy");
      try {
        await grab({
          id: t.youtube || null,
          query: songName(t),
          dur: t.duration,
          name: songName(t),
          art: t.art,
          folder,
          meta: { artist: firstArtist(t.artist), title: t.title, duration: t.duration },
        });
        setRow(i, "done");
        failsInRow = 0;
      } catch (e) {
        setRow(i, "fail", e.message);
        if (++failsInRow >= 4) {
          state.stop = true;
          toast(state.where === "web" ? "4 fails in a row, stopped. The free servers might be busy, try again in a bit" : "4 fails in a row, stopped. Is the helper still open?");
        }
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  } finally {
    state.busy = false;
    updateFoot();
    await window.player.loadLib();
    const added = l.tracks.filter((t) => t.st === "done").length;
    if (added) toast(`Added ${added} song${added > 1 ? "s" : ""} to "${folder}"`);
  }
}

// "My files": you already have the audio, just match it to the playlist (old v2.10 tool)
function useMyFiles() {
  const lt = window.libraryTools;
  if (!lt || !lt.useMyFiles) return toast("That tool didn't load, refresh the page");
  window.ui._pendingPlaylistTracks = state.list.tracks.map((t) => ({ name: songName(t), url: "" }));
  window.ui._pendingPlaylistName = state.list.title;
  const inp = document.createElement("input");
  inp.type = "file";
  inp.multiple = true;
  inp.accept = "audio/*";
  inp.onchange = async () => {
    const files = Array.from(inp.files);
    close();
    await lt.useMyFiles(files);
  };
  inp.click();
}

// ------------------------------------------------------------------ wire up
// a Sync Link from another device: a plain list of "Artist - Title" names
function loadNames(title, names) {
  open("playlist");
  state.list = { title, tracks: names.map((n) => ({ title: n, artist: "" })) };
  state.list.tracks.forEach((t) => (t.st = haveSong(t) ? "have" : "todo"));
  renderList();
}

window.finder = { open, close, ping: pingHelper, loadNames };
if (window.ui) {
  // the old "Import URL" buttons now open this
  window.ui.openPlaylistImporter = () => open("playlist");
}
