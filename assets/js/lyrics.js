// okMUSIC lyrics: finds synced lyrics for your songs (lrclib.net, free, no account) and shows
// them on the left, Apple Music style: the current line lights up and everything glides.
//
// Lyrics are looked up when a song is downloaded through Add Songs, or the first time you play
// a song, then saved with the song so it works offline after that.

const API = "https://lrclib.net/api";
const RETRY_AFTER = 7 * 24 * 3600 * 1000; // "not found" gets checked again after a week
const $ = (id) => document.getElementById(id);
const toast = (m) => window.ui && window.ui.showToast(m);

// ------------------------------------------------------------------ name -> artist / title
const JUNK =
  /\s*[\(\[\{][^\)\]\}]*(official|video|audio|lyric|lyrics|visuali[sz]er|hd|hq|4k|remaster|slowed|sped|speed|reverb|nightcore|8d|bass ?boost|instrumental|extended|clean|explicit|mv|m\/v)[^\)\]\}]*[\)\]\}]/gi;
function cleanPart(s) {
  return (s || "")
    .replace(JUNK, " ")
    .replace(/\s+(ft|feat|featuring)\.?\s.*$/i, "")
    .replace(/\s*\|.*$/, "")
    .replace(/^[\s\-_"']+|[\s\-_"']+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function parseName(name) {
  const base = (name || "").replace(/\.[a-z0-9]{2,4}$/i, "");
  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: cleanPart(parts[0]), title: cleanPart(parts.slice(1).join(" - ")), raw: cleanPart(base) };
  return { artist: "", title: cleanPart(base), raw: cleanPart(base) };
}
const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

// ------------------------------------------------------------------ lrclib lookup
async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("lyrics site said " + res.status);
  return res.json();
}
function pickBest(list, want) {
  if (!Array.isArray(list) || !list.length) return null;
  const t = norm(want.title);
  const a = norm(want.artist);
  let best = null;
  let bestScore = -1e9;
  for (const x of list) {
    if (x.instrumental) continue;
    if (!x.syncedLyrics && !x.plainLyrics) continue;
    let sc = 0;
    if (x.syncedLyrics) sc += 5;
    const xt = norm(x.trackName);
    if (t && (xt === t)) sc += 6;
    else if (t && (xt.includes(t) || t.includes(xt))) sc += 3;
    if (a && norm(x.artistName).includes(a.split(" ")[0])) sc += 4;
    if (want.duration && x.duration) {
      const d = Math.abs(x.duration - want.duration);
      sc += d < 3 ? 4 : d < 10 ? 2 : 0;
    }
    if (sc > bestScore) {
      bestScore = sc;
      best = x;
    }
  }
  return bestScore >= 6 ? best : null;
}
async function lookup(hint) {
  const want = { artist: hint.artist || "", title: hint.title || "", duration: hint.duration || 0 };
  if (!want.title && hint.name) Object.assign(want, parseName(hint.name));
  if (!want.title) return null;
  let found = null;
  if (want.artist) {
    const qs = new URLSearchParams({ track_name: want.title, artist_name: want.artist });
    found = pickBest(await getJson(`${API}/search?${qs}`), want);
  }
  if (!found) {
    const q = [want.artist, want.title].filter(Boolean).join(" ");
    found = pickBest(await getJson(`${API}/search?${new URLSearchParams({ q })}`), want);
  }
  if (!found) return null;
  return { synced: found.syncedLyrics || null, plain: found.plainLyrics || null, dur: found.duration || 0 };
}

// Finds + saves lyrics for one song. hint: {artist,title,duration} or {name}
async function prefetch(songId, hint = {}, force = false) {
  const song = (window.player.songs || []).find((s) => s.id === songId);
  if (song && !force && song.lyricsAt && (song.lyrics || Date.now() - song.lyricsAt < RETRY_AFTER)) return song.lyrics;
  const h = { ...hint };
  if (!h.title && !h.name) h.name = song ? song.name : "";
  const lyrics = await lookup(h).catch((e) => {
    console.warn("lyrics lookup failed", e);
    return undefined; // network problem: don't remember it as "no lyrics"
  });
  if (lyrics === undefined) return null;
  const upd = { lyrics, lyricsAt: Date.now() };
  await window.player.db.update(songId, upd).catch(() => {});
  const live = (window.player.songs || []).find((s) => s.id === songId);
  if (live) Object.assign(live, upd);
  return lyrics;
}

// ------------------------------------------------------------------ parsing LRC
function parseLrc(text) {
  const out = [];
  for (const line of (text || "").split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const words = line.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of tags) out.push({ t: +m[1] * 60 + +m[2], text: words });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// ------------------------------------------------------------------ UI
const st = {
  open: localStorage.getItem("okmusic_lyrics_open") === "true",
  song: null,
  lines: [],
  scale: 1, // slowed / sped-up files: stretch the timestamps to fit
  off: 0, // v2.28.0: seconds the lyrics are shifted (video clip intros), auto + your nudges
  active: -2,
  raf: 0,
  userScrollUntil: 0,
  manual: 0,
};

function build() {
  if ($("lyricsPane")) return;
  const pane = document.createElement("div");
  pane.id = "lyricsPane";
  pane.innerHTML = `<div id="lyricsTrack"></div>`;
  document.body.appendChild(pane);
  // own element (the pane fades out at its edges, this shouldn't)
  const bar = document.createElement("div");
  bar.id = "lyricsSync";
  bar.title = "Lyrics too early / too late? Nudge them (saved for this song)";
  bar.innerHTML = `<button type="button" data-d="-0.5" title="Lyrics come earlier"><i class="fa-solid fa-backward"></i></button>
      <span id="lyricsOff" role="button" title="Tap, then tap the line you hear = perfect sync">sync</span>
      <button type="button" data-d="0.5" title="Lyrics come later"><i class="fa-solid fa-forward"></i></button>`;
  document.body.appendChild(bar);
  bar.addEventListener("click", (e) => {
    e.stopPropagation();
    const b = e.target.closest("button[data-d]");
    if (b) return nudge(+b.dataset.d);
    if (e.target.closest("#lyricsOff")) {
      st.tapSync = !st.tapSync;
      updateScale();
      if (st.tapSync) toast("Tap the line you're hearing right now");
    }
  });
  pane.addEventListener("click", (e) => {
    const line = e.target.closest(".ly-line[data-t]");
    if (!line || pane.classList.contains("plain")) return;
    const a = window.audioSys.audio;
    if (st.tapSync && st.song) {
      // that line is being sung NOW (minus ~0.25 s to tap): shift everything to match
      st.tapSync = false;
      const want = a.currentTime - 0.25 - +line.dataset.t * st.scale;
      const s = st.song;
      s.lyricsNudge = Math.round((want - (st.off - (s.lyricsNudge || 0))) * 10) / 10;
      saveNudge(s);
      updateScale();
      tick(true);
      toast("Lyrics synced ✅");
      return;
    }
    a.currentTime = Math.max(0, +line.dataset.t * st.scale + st.off + 0.01);
    st.userScrollUntil = 0;
    st.manual = 0;
  });
  // scroll wheel / finger: look around for a moment, then it snaps back to the song
  pane.addEventListener("wheel", (e) => {
    if (pane.classList.contains("plain")) return;
    e.preventDefault();
    st.manual -= e.deltaY;
    st.userScrollUntil = performance.now() + 2500;
    position(true);
  }, { passive: false });
  let ty = null;
  pane.addEventListener("touchstart", (e) => (ty = e.touches[0].clientY), { passive: true });
  pane.addEventListener("touchmove", (e) => {
    if (ty == null || pane.classList.contains("plain")) return;
    st.manual += e.touches[0].clientY - ty;
    ty = e.touches[0].clientY;
    st.userScrollUntil = performance.now() + 2500;
    position(true);
  }, { passive: true });
}

function setBtn(mode) {
  const b = $("lyricsBtn");
  if (!b) return;
  b.classList.remove("none", "has", "loading");
  b.classList.add(mode);
  b.classList.toggle("open", st.open && mode === "has");
  b.title = mode === "has" ? "Lyrics" : mode === "loading" ? "Looking for lyrics..." : "No lyrics found for this song";
}

function render() {
  build();
  const track = $("lyricsTrack");
  const pane = $("lyricsPane");
  const L = st.song && st.song.lyrics;
  st.lines = [];
  st.active = -2;
  st.manual = 0;
  if (!L) {
    track.innerHTML = "";
    return;
  }
  if (L.synced) {
    pane.classList.remove("plain");
    st.lines = parseLrc(L.synced);
    // instrumental breaks show as a little "..." line
    track.innerHTML =
      st.lines.map((l, i) => `<div class="ly-line${l.text ? "" : " gap"}" data-i="${i}" data-t="${l.t}">${l.text ? escapeHtml(l.text) : "• • •"}</div>`).join("") +
      `<div class="ly-credit">Lyrics from LRCLIB</div>`;
  } else {
    pane.classList.add("plain");
    track.style.transform = "";
    track.innerHTML =
      L.plain.split(/\r?\n/).map((l) => `<div class="ly-line">${escapeHtml(l) || "&nbsp;"}</div>`).join("") +
      `<div class="ly-credit">Lyrics from LRCLIB (not synced)</div>`;
  }
  const bar = $("lyricsSync");
  if (bar) bar.classList.toggle("plain", !L.synced); // unsynced lyrics: nothing to nudge
  updateScale();
  tick(true);
  if (L.synced) autoSync(st.song);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
// v2.28.0: before, ANY file a bit longer than the lyrics' song (a video clip with an intro / outro)
// was treated as a SLOWED version and every line got stretched -> lyrics later and later.
// Now: stretched only when the name says slowed / sped up / nightcore. A longer "official video"
// file gets the lyrics SHIFTED to where the beat really starts in it (kick map). Plus the
// << sync >> bar: nudge by 0.5 s, or tap "sync" then tap the line you hear (saved per song).
const SYNC_V = 2;
const STRETCHED = /slowed|sped|speed ?up|nightcore|daycore|reverb/i;
function updateScale() {
  const s = st.song;
  const L = s && s.lyrics;
  const sync = s && s.lyricsSync;
  st.scale = 1;
  st.off = 0;
  const dur = window.audioSys.audio.duration;
  if (L && L.dur && dur && isFinite(dur) && STRETCHED.test((s && s.name) || "")) {
    const r = dur / L.dur;
    if (r > 0.6 && r < 1.6 && Math.abs(r - 1) > 0.02) st.scale = r; // real slowed / sped-up version
  } else if (sync && sync.v === SYNC_V) st.off = sync.off || 0;
  st.off += (s && s.lyricsNudge) || 0;
  const o = $("lyricsOff");
  if (o) o.textContent = st.tapSync ? "tap a line" : st.off ? (st.off > 0 ? "+" : "") + st.off.toFixed(1) + "s" : "sync";
}
function autoSync(song) {
  const L = song && song.lyrics;
  if (!L || !L.synced || !L.dur || (song.lyricsSync && song.lyricsSync.v === SYNC_V)) return;
  if (STRETCHED.test(song.name || "")) return;
  const km = song.kickMap && song.kickMap.t;
  const a = window.audioSys.audio;
  const dur = (song.trim && song.trim.d) || (st.song === song && a.duration && isFinite(a.duration) ? a.duration : 0);
  if (!km || !dur) return; // not scanned yet: tried again next time the lyrics show
  const first = parseLrc(L.synced).find((l) => l.text);
  if (!first) return;
  const extra = dur - L.dur; // seconds the file is longer (video clip intro / outro)
  let off = 0;
  if (extra > 2 && km.length) {
    // the song proper starts where the beat starts: line it up so the first line lands there
    // (the original's rap usually starts with its beat), never more than the extra length
    off = Math.max(0, Math.min(extra, km[0] - first.t));
    if (off < 1) off = 0;
  }
  song.lyricsSync = { v: SYNC_V, off: +off.toFixed(2) };
  if (song.blob && !String(song.id).startsWith("ss_")) window.player.db.update(song.id, { lyricsSync: song.lyricsSync }).catch(() => {});
  if (st.song === song) {
    updateScale();
    tick(true);
  }
}
function saveNudge(s) {
  if (s.blob && !String(s.id).startsWith("ss_")) window.player.db.update(s.id, { lyricsNudge: s.lyricsNudge }).catch(() => {});
}
function nudge(d) {
  const s = st.song;
  if (!s) return;
  s.lyricsNudge = Math.round((((s.lyricsNudge || 0) + d) * 10)) / 10;
  saveNudge(s);
  updateScale();
  tick(true);
  toast(d > 0 ? "Lyrics a bit later" : "Lyrics a bit earlier");
}

function currentIndex(t) {
  const L = st.lines;
  let lo = 0, hi = L.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (L[mid].t * st.scale + st.off <= t + 0.15) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
function position(immediate) {
  const pane = $("lyricsPane");
  const track = $("lyricsTrack");
  if (!pane || pane.classList.contains("plain")) return;
  const rows = track.children;
  const i = Math.max(0, st.active);
  const row = rows[i];
  if (!row) return;
  const target = pane.clientHeight * 0.36 - (row.offsetTop + row.offsetHeight / 2);
  const manual = performance.now() < st.userScrollUntil ? st.manual : (st.manual = 0);
  track.style.transition = immediate ? "none" : "";
  track.style.transform = `translate3d(0, ${target + manual}px, 0)`;
}
function tick(force) {
  if (!st.open || !st.lines.length) return;
  // first play of a song: the kick scan finishes a moment later, then the lyrics get lined up
  const so = st.song;
  if (so && so.kickMap && !(so.lyricsSync && so.lyricsSync.v === SYNC_V)) autoSync(so);
  const t = window.audioSys.audio.currentTime;
  const idx = currentIndex(t);
  if (idx !== st.active || force) {
    st.active = idx;
    const rows = $("lyricsTrack").children;
    for (let k = 0; k < st.lines.length; k++) {
      const r = rows[k];
      const d = Math.abs(k - Math.max(0, idx));
      r.classList.toggle("on", k === idx);
      r.style.setProperty("--b", k === idx ? "0px" : Math.min(2.5, 0.6 + d * 0.45) + "px");
    }
    position(false);
  } else if (st.manual && performance.now() >= st.userScrollUntil) {
    position(false); // snap back after looking around
  }
}
function loop() {
  cancelAnimationFrame(st.raf);
  const step = () => {
    if (!st.open) return;
    if (!document.hidden && !window.okAway) tick(false);
    st.raf = requestAnimationFrame(step);
  };
  st.raf = requestAnimationFrame(step);
}

function applyOpen() {
  const has = !!(st.song && st.song.lyrics);
  document.body.classList.toggle("lyrics-open", st.open && has);
  setBtn(has ? "has" : $("lyricsBtn") && $("lyricsBtn").classList.contains("loading") ? "loading" : "none");
  if (st.open && has) {
    render();
    loop();
  } else cancelAnimationFrame(st.raf);
}

async function onTrack(song) {
  st.song = song;
  build();
  if (song && song.lyrics) {
    applyOpen();
    return;
  }
  document.body.classList.remove("lyrics-open");
  if (!song) return setBtn("none");
  const fresh = song.lyricsAt && Date.now() - song.lyricsAt < RETRY_AFTER;
  if (fresh) return setBtn("none");
  setBtn("loading");
  const a = window.audioSys.audio;
  const dur = a.duration && isFinite(a.duration) ? a.duration : 0;
  await prefetch(song.id, { name: song.name, duration: dur });
  if (st.song !== song) return;
  const live = (window.player.songs || []).find((s) => s.id === song.id) || song;
  st.song = live;
  setBtn(live.lyrics ? "has" : "none");
  applyOpen();
}

function toggle() {
  const has = !!(st.song && st.song.lyrics);
  if (!has) {
    const b = $("lyricsBtn");
    if (b && b.classList.contains("loading")) return toast("Still looking for lyrics...");
    if (!st.song) return toast("Play a song first");
    // one more try (maybe the name got fixed, or internet was off)
    toast("Looking for lyrics again...");
    st.song.lyricsAt = 0;
    return onTrack(st.song).then(() => {
      if (!(st.song && st.song.lyrics)) toast("No lyrics found for this song 😔");
      else {
        st.open = true;
        localStorage.setItem("okmusic_lyrics_open", "true");
        applyOpen();
      }
    });
  }
  st.open = !st.open;
  localStorage.setItem("okmusic_lyrics_open", String(st.open));
  applyOpen();
}

function init() {
  if (!window.ui || !window.player) return;
  build();
  setBtn("none");
  const origSet = window.ui.setTrack.bind(window.ui);
  window.ui.setTrack = (s) => {
    const r = origSet(s);
    if (!st.song || !s || st.song.id !== s.id) onTrack(s);
    return r;
  };
  const a = window.audioSys.audio;
  a.addEventListener("loadedmetadata", () => {
    updateScale();
    if (st.open) tick(true);
  });
  a.addEventListener("seeked", () => st.open && tick(true));
  window.addEventListener("resize", () => st.open && position(true));
  if (window.player.currentTrack) onTrack(window.player.currentTrack);
}

window.lyrics = { toggle, prefetch, onTrack, parseName, lookup, autoSync, nudge, get state() { return st; } };
init();
