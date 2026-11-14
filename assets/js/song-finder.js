// okMUSIC v3 "Add Songs": search any song, or grab a whole Spotify / YouTube playlist,
// and it lands in your library (playlists get their own folder).
//
// The actual downloading is done by the okMUSIC helper running on your PC
// (helper/okmusic-helper.py). YouTube blocks downloads from big servers, but
// from your own PC it works - so the page talks to the helper at 127.0.0.1.

const HELPER = "http://127.0.0.1:47823";
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

async function pingHelper() {
  try {
    const j = await helperFetch("/ping", { timeout: 2000 });
    setHelper(!!j.ok);
  } catch (e) {
    setHelper(false);
  }
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
  st.querySelector("span.txt").textContent = ok ? "PC helper connected" : "PC helper isn't running";
  st.querySelector("button").textContent = ok ? "" : $("finderSetup").hidden ? "How to start it" : "Hide steps";
  st.querySelector("button").style.display = ok ? "none" : "";
  if (ok && was === false) toast("Helper connected 🎉");
  clearInterval(state.pollTimer);
  if (!ok && isOpen()) state.pollTimer = setInterval(pingHelper, 3000);
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
async function grab({ id, query, dur, name, art, folder }) {
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
  const cover = (art && (await toDataUrl(art))) || (vid && (await toDataUrl(`${HELPER}/thumb?id=${encodeURIComponent(vid)}`)));
  if (cover) await window.player.db.update(songId, { art: cover }).catch(() => {});
  if (folder) {
    folderByName(folder, true).items.push({ type: "song", id: songId });
    window.libraryMgr.save();
  }
  refreshLibrarySoon();
  if (window.ltStorage) window.ltStorage.afterAdd && window.ltStorage.afterAdd();
  return songId;
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
    <div class="finder-status" id="finderStatus"><span class="dot"></span><span class="txt">Looking for the PC helper...</span><button type="button"></button></div>
    <div class="finder-setup" id="finderSetup" hidden>
      <b>One-time setup (PC only)</b>
      <ol>
        <li>Download <a href="helper/okmusic-helper.py" download>okmusic-helper.py</a> and <a href="helper/Start%20okMUSIC%20Helper.bat" download>Start okMUSIC Helper.bat</a>, put both in the same folder.</li>
        <li>Double-click <b>Start okMUSIC Helper.bat</b>. A black window opens, leave it open. (Needs <a href="https://www.python.org/downloads/" target="_blank" rel="noopener">Python</a>, tick "Add to PATH" when installing.)</li>
        <li>Come back here, it connects by itself. If the browser asks to <i>access devices on your network</i>, press Allow.</li>
      </ol>
      <span style="opacity:.6">On your phone: add songs on the PC, then use <b>Generate Sync Link</b> in the library.</span>
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
}

function needHelper() {
  if (state.helperOk) return true;
  $("finderSetup").hidden = false;
  setHelper(false);
  toast("Start the PC helper first (steps are at the top)");
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
  if (/open\.spotify\.com\/(playlist|album)|[?&]list=/.test(q)) {
    setTab("playlist");
    $("finderInput").value = q;
    return loadList(q);
  }
  body.innerHTML = `<div class="finder-empty"><i class="fa-solid fa-spinner fa-spin"></i>Searching...</div>`;
  try {
    let results;
    if (yt) results = [{ id: yt[1], title: "YouTube video", channel: "from your link", duration: 0, thumb: `https://i.ytimg.com/vi/${yt[1]}/mqdefault.jpg` }];
    else if (/open\.spotify\.com\/track/.test(q)) {
      const l = await helperFetch("/list?url=" + encodeURIComponent(q));
      const t = l.tracks[0];
      results = (await helperFetch(`/search?n=6&q=${encodeURIComponent(songName(t) + " audio")}`)).results;
    } else results = (await helperFetch(`/search?n=8&q=${encodeURIComponent(q)}`)).results;
    if (!results.length) {
      body.innerHTML = `<div class="finder-empty">Nothing found. Try the artist + song name.</div>`;
      return;
    }
    body.innerHTML = results
      .map(
        (r, i) => `
      <div class="f-item">
        <img class="f-thumb" src="${esc(r.thumb)}" alt="" loading="lazy">
        <div class="f-meta"><div class="f-title">${esc(r.title)}</div><div class="f-sub">${esc(r.channel)}${r.duration ? " · " + fmtDur(r.duration) : ""}</div></div>
        <button type="button" class="f-act" data-i="${i}" title="Add to library"><i class="fa-solid fa-plus"></i></button>
      </div>`,
      )
      .join("");
    body.querySelectorAll(".f-act").forEach((b) =>
      b.addEventListener("click", async () => {
        if (b.classList.contains("busy") || b.classList.contains("done")) return;
        const r = results[+b.dataset.i];
        b.className = "f-act busy";
        b.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
        try {
          const folder = $("finderFolder").value || null;
          await grab({ id: r.id, name: r.channel && !/ - /.test(r.title) ? `${r.channel.replace(/ - Topic$/, "")} - ${r.title}` : r.title, folder });
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
        : `<div class="finder-empty">Couldn't load your playlists (${esc(e.message)}). Paste a link above instead.</div>`;
  }
}

async function loadList(link) {
  if (!link) return showMyPlaylists();
  if (state.busy) return toast("Still downloading, hit Stop first");
  const body = $("finderBody");
  body.innerHTML = `<div class="finder-empty"><i class="fa-solid fa-spinner fa-spin"></i>Reading the song list...</div>`;
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
        body.innerHTML = `<div class="finder-empty">The PC helper reads the playlist. Start it (steps at the top), then press Load again.</div>`;
        return;
      }
      list = await helperFetch("/list?url=" + encodeURIComponent(link));
    }
    if (!list.tracks.length) throw new Error("that list is empty");
    list.tracks.forEach((t) => (t.st = haveSong(t) ? "have" : "todo"));
    state.list = list;
    renderList();
  } catch (e) {
    body.innerHTML = `<div class="finder-empty"><i class="fa-solid fa-triangle-exclamation"></i>${esc(e.message)}</div>`;
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
        <span class="f-state ${t.st}">${ICON[t.st]}</span>
      </div>`,
      )
      .join("")}</div>`;
  updateCount();
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
        });
        setRow(i, "done");
        failsInRow = 0;
      } catch (e) {
        setRow(i, "fail", e.message);
        if (++failsInRow >= 4) {
          state.stop = true;
          toast("4 fails in a row, stopped. Is the helper still open?");
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
