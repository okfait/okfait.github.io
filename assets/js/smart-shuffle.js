// okMUSIC v2.26.0 - Smart Shuffle (like Spotify's): the shuffle button now has 3 states
//   off -> Shuffle -> Smart Shuffle -> off
// Smart Shuffle finds NEW songs you don't have yet and mixes them into your library list.
//
// Where the picks come from: YouTube's own "radio mix" of songs you already have (the
// endless "Mix - <song>" list YouTube makes for every video = songs people listen to together).
// We take 3 of your songs (the one playing, your most played ones from Wrapped, a random one),
// read their mixes, throw out everything you already own / hid / that isn't a normal song
// (full albums, 1 hour loops, type beats...) and keep a pool of picks.
//
// In the library a pick looks different: sparkle badge on the cover, "Smart Shuffle" line
// with the song it came from, a + button (keeps it = downloads it into your library for real)
// and an x button (never suggest that one again). While shuffling, every 3rd song is a pick.
// Picks are only downloaded when they're about to play, and stay in memory (not saved) until
// you press +.
//
// Saved on this device: okmusic_ss_on (on/off), okmusic_ss_pool (the picks, refreshed after
// 12 h or with the refresh button), okmusic_ss_no (songs you hid).

const P = window.player;
const $ = (id) => document.getElementById(id);
const toast = (m, ms) => window.ui && window.ui.showToast(m, ms);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const K_ON = "okmusic_ss_on", K_POOL = "okmusic_ss_pool", K_NO = "okmusic_ss_no";
const EVERY = 3; // every 3rd song while shuffling = a pick
const FRESH_MS = 12 * 3600 * 1000;
const PREFIX = "ss_";

const S = {
  on: localStorage.getItem(K_ON) === "1",
  pool: [], // [{yt, title, artist, dur, seed}]
  at: 0,
  loading: false,
  err: "",
  no: new Set(),
  cache: new Map(), // yt -> {blob, ext, art} (downloaded picks, in memory only)
  getting: new Map(), // yt -> Promise
  sinceLast: 0, // library songs played since the last pick
  lastLibId: null,
  played: new Set(), // picks already played this session
};
try {
  const p = JSON.parse(localStorage.getItem(K_POOL) || "null");
  if (p && Array.isArray(p.items)) {
    S.pool = p.items;
    S.at = p.at || 0;
  }
} catch (e) {}
try {
  (JSON.parse(localStorage.getItem(K_NO) || "[]") || []).forEach((x) => S.no.add(x));
} catch (e) {}

function savePool() {
  try {
    localStorage.setItem(K_POOL, JSON.stringify({ at: S.at, items: S.pool }));
  } catch (e) {}
}
const isPick = (id) => typeof id === "string" && id.startsWith(PREFIX);
const pickOf = (id) => S.pool.find((x) => PREFIX + x.yt === id);

// ------------------------------------------------------------------ what you already have
function norm(s) {
  const f = window.finder && window.finder.api && window.finder.api.norm;
  return f ? f(s) : String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function cleanArtist(a) {
  return String(a || "").replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").replace(/\s*(official)?\s*$/i, "").trim();
}
// "Artist - Title" for a YouTube video (channel name as the artist when the title has none)
// YouTube junk out of the name: (Official Video), | Videoclip Oficial, [Lyrics], "quotes"...
const TAG = /official|oficial|video|videoclip|audio|lyric|lyrics|visuali[sz]er|clip|hd|4k|explicit|prod\.?/i;
function cleanTitle(t) {
  return String(t || "")
    .replace(/\s*[([]([^)\]]*)[)\]]/g, (m, x) => (TAG.test(x) ? "" : m))
    .replace(/\s*[|｜]\s*[^|｜]*$/g, (m) => (TAG.test(m) ? "" : m))
    .replace(/["“”]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
function niceName(v) {
  const t = cleanTitle(v.title) || String(v.title || "").trim();
  if (/ [-–—] /.test(t)) return t;
  const a = cleanArtist(v.artist);
  return a ? `${a} - ${t}` : t;
}
function split(name) {
  const sn = window.songNames;
  if (sn && sn.splitName) return sn.splitName(name);
  const i = name.indexOf(" - ");
  return i > 0 ? { artist: name.slice(0, i), title: name.slice(i + 3) } : { artist: "", title: name };
}
function libKeys() {
  const yts = new Set(), full = new Set(), titles = [];
  for (const s of P.songs || []) {
    if (isPick(s.id)) continue;
    if (s.yt) yts.add(s.yt);
    full.add(norm(s.name));
    const p = split(s.name || "");
    const t = norm(p.title);
    if (t.length >= 3) titles.push({ t, a: norm(p.artist) });
  }
  return { yts, full, titles };
}
function owned(v, keys) {
  if (keys.yts.has(v.yt)) return true;
  const name = niceName(v);
  if (keys.full.has(norm(name))) return true;
  const p = split(name);
  const t = norm(p.title), a = norm(p.artist);
  if (!t) return false;
  return keys.titles.some((x) => x.t === t && (!x.a || !a || x.a.includes(a.split(" ")[0]) || a.includes(x.a.split(" ")[0])));
}
// not a normal song: full albums, hour loops, mixes, reactions, type beats, shorts...
const JUNK = /\b(full album|album complet|full ep|\d+\s*(hour|hr)s?\b|1h\b|mix 20\d\d|playlist|compilation|nonstop|non-stop|live ?stream|reaction|reacting|type beat|karaoke|tutorial|podcast|interview|trailer|#shorts)\b/i;
function okSong(v) {
  if (!v.yt || S.no.has(v.yt)) return false;
  if (v.dur && (v.dur < 70 || v.dur > 600)) return false;
  return !JUNK.test(v.title || "");
}

// ------------------------------------------------------------------ finding picks
function seedSongs() {
  const lib = (P.songs || []).filter((s) => !isPick(s.id));
  if (!lib.length) return [];
  const out = [];
  const add = (s) => s && !out.includes(s) && out.push(s);
  const cur = lib.find((s) => s.id === P.currId);
  add(cur);
  // your most played songs (Wrapped stats), one of the top 5 at random so refresh gives new picks
  try {
    const st = JSON.parse(localStorage.getItem("okmusic_stats") || "null");
    const top = Object.entries((st && st.songs) || {})
      .sort((a, b) => b[1][0] - a[1][0])
      .slice(0, 5)
      .map(([id]) => lib.find((s) => s.id === id))
      .filter(Boolean);
    if (top.length) add(top[Math.floor(Math.random() * top.length)]);
  } catch (e) {}
  // fill with random ones (songs that know their YouTube video first: no search needed)
  const rnd = [...lib].sort(() => Math.random() - 0.5).sort((a, b) => (b.yt ? 1 : 0) - (a.yt ? 1 : 0));
  for (const s of rnd) {
    if (out.length >= 3) break;
    add(s);
  }
  return out.slice(0, 3);
}
async function videoOf(song) {
  if (song.yt) return song.yt;
  const p = split(song.name || "");
  const q = `${p.artist ? p.artist + " " : ""}${p.title} audio`;
  const r = await window.finder.api.call(`/search?n=1&q=${encodeURIComponent(q)}`);
  return r && r.results && r.results[0] && r.results[0].id;
}
async function mixOf(song) {
  const vid = await videoOf(song);
  if (!vid) return [];
  const url = `https://www.youtube.com/watch?v=${vid}&list=RD${vid}`;
  const l = await window.finder.api.call("/list?url=" + encodeURIComponent(url));
  const seed = split(song.name || "").title || song.name;
  return (l.tracks || [])
    .filter((t) => t.youtube && t.youtube !== vid)
    .map((t) => ({ yt: t.youtube, title: t.title || "", artist: t.artist || "", dur: t.duration || 0, seed }));
}

async function refill(quiet) {
  if (S.loading) return;
  if (!window.finder || !window.finder.api) return;
  S.loading = true;
  S.err = "";
  redraw();
  try {
    if (!(await window.finder.api.ready())) throw new Error("the song servers aren't answering, try again in a bit");
    const seeds = seedSongs();
    if (!seeds.length) throw new Error("add a few songs first, Smart Shuffle finds songs LIKE yours");
    const lists = await Promise.all(seeds.map((s) => mixOf(s).catch((e) => (console.warn("smart shuffle mix failed", s.name, e), []))));
    const keys = libKeys();
    const seen = new Set(), names = new Set(), perArtist = {};
    const picks = [];
    // take turns between the mixes so the picks are a blend of all 3 songs
    for (let i = 0; i < 60; i++) {
      for (const l of lists) {
        const v = l[i];
        if (!v || seen.has(v.yt)) continue;
        seen.add(v.yt);
        if (!okSong(v) || owned(v, keys)) continue;
        const nm = norm(niceName(v));
        if (names.has(nm)) continue; // same song, another upload
        const a = norm(split(niceName(v)).artist) || norm(v.artist);
        if ((perArtist[a] || 0) >= 3) continue; // not 10 songs of the same artist
        perArtist[a] = (perArtist[a] || 0) + 1;
        names.add(nm);
        picks.push(v);
      }
    }
    if (!picks.length) throw new Error("couldn't find new songs right now, try refresh in a bit");
    // keep the picks that are still in the list if they came back again, add the new ones
    S.pool = picks.slice(0, 40);
    S.at = Date.now();
    S.played.clear();
    savePool();
    if (!quiet) toast(`Smart Shuffle found ${S.pool.length} songs for you ✨`, 2500);
    prefetchNext();
  } catch (e) {
    S.err = e.message || String(e);
    if (!quiet) toast("Smart Shuffle: " + S.err, 4000);
  } finally {
    S.loading = false;
    redraw();
  }
}

// how many picks show in the library: about 1 for every 3 of your songs (3..12)
function shown() {
  const n = (P.songs || []).filter((s) => !isPick(s.id)).length;
  const k = Math.max(3, Math.min(12, Math.round(n / EVERY)));
  return S.pool.slice(0, k);
}

// ------------------------------------------------------------------ playing picks
async function getAudio(v) {
  if (S.cache.has(v.yt)) return S.cache.get(v.yt);
  if (S.getting.has(v.yt)) return S.getting.get(v.yt);
  const job = (async () => {
    if (!(await window.finder.api.ready())) throw new Error("the song servers aren't answering");
    const f = await window.finder.api.fetchSong({ id: v.yt, name: niceName(v) });
    const art = (await window.finder.api.toDataUrl(`https://i.ytimg.com/vi/${v.yt}/mqdefault.jpg`)) || null;
    const got = { blob: f.blob, ext: f.ext, art };
    S.cache.set(v.yt, got);
    // keep memory sane: only the last 4 downloaded picks (and never the one playing)
    while (S.cache.size > 4) {
      const old = [...S.cache.keys()].find((k) => PREFIX + k !== P.currId);
      if (!old) break;
      S.cache.delete(old);
    }
    return got;
  })();
  S.getting.set(v.yt, job);
  try {
    return await job;
  } finally {
    S.getting.delete(v.yt);
  }
}
// the pick as a (not saved) song record the player understands
function record(v, got) {
  const id = PREFIX + v.yt;
  // only the pick that's playing lives in the song list (so backups / send-to-phone never see picks)
  P.songs = (P.songs || []).filter((s) => !isPick(s.id) || s.id === id);
  let r = P.songs.find((s) => s.id === id);
  if (!r) {
    r = { id, name: niceName(v), yt: v.yt, art: got.art, blob: got.blob, beatSignals: [], suggested: true };
    P.songs.push(r);
  }
  r.blob = got.blob;
  r.art = got.art || r.art;
  return r;
}
function nextPick() {
  return shown().find((v) => !S.played.has(v.yt) && PREFIX + v.yt !== P.currId);
}
function prefetchNext() {
  if (!S.on) return;
  const v = nextPick();
  if (v && !S.cache.has(v.yt)) getAudio(v).catch((e) => console.warn("smart shuffle prefetch failed", e));
}
function playNow(v) {
  const got = S.cache.get(v.yt);
  const r = record(v, got);
  S.played.add(v.yt);
  S.sinceLast = 0;
  P.play(r.id, null, false);
  window.ui.highlightActiveTrack(r.id);
  setTimeout(prefetchNext, 1500);
}
async function play(yt) {
  const v = S.pool.find((x) => x.yt === yt);
  if (!v) return;
  if (!S.cache.has(yt)) {
    setBusy(yt, true);
    toast("Getting that song...", 2000);
    try {
      await getAudio(v);
    } catch (e) {
      toast("Couldn't get that song: " + e.message, 4000);
      return;
    } finally {
      setBusy(yt, false);
    }
  }
  if (P.currId && !isPick(P.currId)) S.lastLibId = P.currId;
  playNow(v);
}

// "next song": while Smart Shuffle is on, every 3rd song is a pick (only if it's already
// downloaded, so Auto DJ's crossfade never waits; otherwise the next time)
const origNext = P.next.bind(P);
P.next = function () {
  const cur = P.currId;
  if (!S.on || !P.shuffle || (P.queue && P.queue.length)) return origNext();
  if (!isPick(cur)) {
    S.lastLibId = cur;
    S.sinceLast++;
  }
  const v = S.sinceLast >= EVERY - 1 && nextPick();
  if (v && S.cache.has(v.yt)) return playNow(v);
  if (v) prefetchNext();
  return origNext();
};
// "previous" on a pick goes back to the library song before it
const origPrev = P.prev.bind(P);
P.prev = function () {
  if (isPick(P.currId) && S.lastLibId && P.songs.some((s) => s.id === S.lastLibId)) return P.play(S.lastLibId);
  return origPrev();
};
// the library reloads from storage now and then: keep the pick that's playing in the list
const origLoad = P.loadLib.bind(P);
P.loadLib = async function () {
  const keep = (P.songs || []).filter((s) => isPick(s.id));
  await origLoad();
  for (const r of keep) if (!P.songs.some((s) => s.id === r.id)) P.songs.push(r);
  redraw();
};

// ------------------------------------------------------------------ keep / hide
async function keep(yt) {
  const v = S.pool.find((x) => x.yt === yt);
  if (!v) return;
  setBusy(yt, true);
  try {
    const got = await getAudio(v);
    const id = await window.finder.api.saveSong({ blob: got.blob, ext: got.ext, vid: v.yt, title: niceName(v), art: got.art, meta: { name: niceName(v), duration: v.dur } });
    S.pool = S.pool.filter((x) => x.yt !== yt);
    savePool();
    const wasPlaying = P.currId === PREFIX + yt;
    await P.loadLib();
    P.songs = P.songs.filter((s) => s.id !== PREFIX + yt);
    if (wasPlaying) {
      // it's the same song, just saved now: keep playing, point at the saved one
      const s = P.songs.find((x) => x.id === id);
      if (s) {
        P.currId = id;
        P.currentTrack = s;
        localStorage.setItem("okmusic_last_song", id);
      }
    }
    window.ui.renderLibrary();
    toast(`Added "${split(niceName(v)).title}" to your library ✅`, 2500);
  } catch (e) {
    toast("Couldn't add it: " + e.message, 4000);
  } finally {
    setBusy(yt, false);
  }
}
function hide(yt) {
  S.no.add(yt);
  try {
    localStorage.setItem(K_NO, JSON.stringify([...S.no].slice(-500)));
  } catch (e) {}
  S.pool = S.pool.filter((x) => x.yt !== yt);
  S.cache.delete(yt);
  savePool();
  redraw();
  toast("Got it, won't suggest that one again", 2000);
}

// ------------------------------------------------------------------ the library list
function setBusy(yt, on) {
  const c = document.querySelector(`.ss-card[data-id="${PREFIX + yt}"]`);
  if (c) c.classList.toggle("ss-busy", on);
}
function card(v) {
  const id = PREFIX + v.yt;
  const p = split(niceName(v));
  const c = document.createElement("div");
  c.className = "lib-card group ss-card" + (P.currId === id ? " active" : "");
  c.dataset.id = id;
  c.draggable = false;
  c.innerHTML = `
    <div class="lib-card-icon has-art" style="background-image:url('https://i.ytimg.com/vi/${encodeURIComponent(v.yt)}/mqdefault.jpg')"><i class="ss-spin fa-solid fa-spinner fa-spin"></i></div>
    <div class="lib-card-info">
      <div class="lib-card-title">${esc(p.title)}</div>
      ${p.artist ? `<div class="lib-card-artist">${esc(p.artist)}</div>` : ""}
      <div class="ss-why"><i class="fa-solid fa-wand-magic-sparkles"></i> ${v.seed ? "because of " + esc(v.seed) : "Smart Shuffle"}</div>
    </div>
    <div class="ss-acts">
      <button type="button" class="ss-add" title="Add to your library"><i class="fa-solid fa-plus"></i></button>
      <button type="button" class="ss-no" title="Not for me (won't suggest it again)"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
  c.onclick = () => play(v.yt);
  c.oncontextmenu = (e) => e.preventDefault();
  c.querySelector(".ss-add").onclick = (e) => {
    e.stopPropagation();
    keep(v.yt);
  };
  c.querySelector(".ss-no").onclick = (e) => {
    e.stopPropagation();
    hide(v.yt);
  };
  return c;
}
function head() {
  const h = document.createElement("div");
  h.className = "ss-head";
  const n = shown().length;
  const txt = S.loading
    ? `<i class="fa-solid fa-spinner fa-spin"></i> finding songs you'd like...`
    : S.err && !n
      ? `<i class="fa-solid fa-triangle-exclamation"></i> ${esc(S.err)}`
      : `<i class="fa-solid fa-wand-magic-sparkles"></i> Smart Shuffle added ${n} new song${n === 1 ? "" : "s"}`;
  h.innerHTML = `<span>${txt}</span><button type="button" title="New picks"${S.loading ? " disabled" : ""}><i class="fa-solid fa-rotate"></i></button>`;
  h.querySelector("button").onclick = () => refill(false);
  return h;
}
// mixes the picks into the list the library just drew: one after every 3 of your items
function decorate(filterText) {
  const el = $("libraryList");
  if (!el || !S.on || filterText || (window.ui && window.ui.selectMode)) return;
  const items = [...el.children].filter((c) => c.classList.contains("lib-card") || c.classList.contains("lib-folder"));
  if (!items.length) return;
  items[0].before(head());
  const picks = shown();
  let k = 0;
  for (let i = EVERY - 1; i < items.length && k < picks.length; i += EVERY) items[i].after(card(picks[k++]));
  const last = items[items.length - 1];
  let at = last.nextElementSibling && last.nextElementSibling.classList.contains("ss-card") ? last.nextElementSibling : last;
  while (k < picks.length) {
    const c = card(picks[k++]);
    at.after(c);
    at = c;
  }
}
const ui = window.ui;
const origRender = ui.renderLibrary.bind(ui);
ui.renderLibrary = function (filterText = "") {
  origRender(filterText);
  try {
    decorate(filterText);
  } catch (e) {
    console.warn("smart shuffle list failed", e);
  }
};
let redrawT = 0;
function redraw() {
  clearTimeout(redrawT);
  redrawT = setTimeout(() => {
    const q = $("libSearch");
    ui.renderLibrary(q ? q.value : "");
  }, 30);
}

// ------------------------------------------------------------------ the shuffle button
function paintBtn() {
  const b = $("shuffleBtn");
  if (!b) return;
  b.classList.toggle("active", !!P.shuffle);
  b.classList.toggle("ss-on", !!(P.shuffle && S.on));
  b.title = S.on && P.shuffle ? "Smart Shuffle (tap to turn off)" : P.shuffle ? "Shuffle (tap for Smart Shuffle)" : "Shuffle";
}
function setOn(v) {
  S.on = v;
  localStorage.setItem(K_ON, v ? "1" : "0");
  if (v && (!S.pool.length || Date.now() - S.at > FRESH_MS)) refill(true);
  else if (v) prefetchNext();
  paintBtn();
  redraw();
}
// off -> Shuffle -> Smart Shuffle -> off
P.toggleShuffle = function () {
  if (!P.shuffle) {
    P.shuffle = true;
    P.shuffleHistory = [];
    paintBtn();
    toast("Shuffle on · tap again for Smart Shuffle ✨", 2200);
  } else if (!S.on) {
    setOn(true);
    toast("Smart Shuffle on ✨ new songs like yours get mixed in, + keeps one", 3500);
  } else {
    P.shuffle = false;
    setOn(false);
    toast("Shuffle off", 1500);
  }
};
if (S.on) {
  P.shuffle = true;
  paintBtn();
  redraw(); // the library was probably drawn before this file loaded
  // first load: fresh picks if the old ones are stale (quietly, in the background)
  setTimeout(() => (Date.now() - S.at > FRESH_MS || !S.pool.length ? refill(true) : prefetchNext()), 4000);
}

window.smartShuffle = {
  get on() { return S.on; },
  get pool() { return S.pool; },
  get loading() { return S.loading; },
  refill: () => refill(false),
  play,
  keep,
  hide,
  set: setOn,
};
