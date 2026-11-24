// okMUSIC Smart Shuffle (v2.26.0) + Song Radio (v2.27.0)
//
// SMART SHUFFLE (like Spotify's): the shuffle button (main controls) has 3 states
//   off -> Shuffle -> Smart Shuffle -> off
// It finds NEW songs you don't have yet for the folder you're playing from (or your whole
// library when you play from the top level) and mixes them into that folder's list: sparkle
// badge, "because of <song>" line, + keeps it (saved INTO that folder), x = never suggest it again.
// While shuffling, every 3rd song is a pick.
//
// SONG RADIO: right-click a song -> Start Radio, or the radio button in the library (= radio of
// the song playing). Plays the song, then a never-repeating list of songs like it: the ones you
// already have play from your library, the new ones are picks (+ / x like above).
//
// Where songs come from: YouTube's own "radio mix" of a video (the "Mix - <song>" list YouTube
// makes = songs people listen to together). Smart Shuffle blends the mixes of 3-4 songs from the
// folder (the one playing, one you play a lot, random ones).
//
// Picks DOWNLOAD BY THEMSELVES in the background as soon as they're found (one at a time) and
// are kept on this device (IndexedDB "okMUSIC_picks", max ~40), so tapping one plays right away.
// They're NOT in your library until you press +.
//
// localStorage: okmusic_ss_on, okmusic_ss_pools {key: {at, items}} (key = folder id or "root",
// refreshed after 12 h or with the refresh button), okmusic_ss_no (hidden songs).

const P = window.player;
const $ = (id) => document.getElementById(id);
const toast = (m, ms) => window.ui && window.ui.showToast(m, ms);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const K_ON = "okmusic_ss_on", K_POOLS = "okmusic_ss_pools", K_NO = "okmusic_ss_no";
const EVERY = 3; // every 3rd song while shuffling = a pick
const FRESH_MS = 12 * 3600 * 1000;
const PREFIX = "ss_";
const KEEP_FILES = 40; // downloaded picks kept on the device

const S = {
  on: localStorage.getItem(K_ON) === "1",
  pools: {}, // key -> {at, items: [{yt, title, artist, dur, seed}]}
  loading: {}, // key -> true while finding picks
  err: {},
  ctx: "root", // folder id the music is playing from, or "root"
  no: new Set(),
  ready: new Set(), // yt ids downloaded to the device
  mem: new Map(), // yt -> {blob, ext, art} loaded in memory (the next ones up)
  jobs: new Map(), // yt -> download / load promise
  bad: new Set(), // downloads that failed this session
  dl: null, // yt downloading in the background right now
  sinceLast: 0,
  lastLibId: null,
  played: new Set(),
  radio: null, // {seed, seedId, items, idx, loading, all}
};
try {
  S.pools = JSON.parse(localStorage.getItem(K_POOLS) || "null") || {};
  const old = JSON.parse(localStorage.getItem("okmusic_ss_pool") || "null"); // v2.26.0
  if (old && old.items && !S.pools.root) {
    S.pools.root = old;
    localStorage.setItem(K_POOLS, JSON.stringify(S.pools));
  }
  localStorage.removeItem("okmusic_ss_pool");
} catch (e) {}
try {
  (JSON.parse(localStorage.getItem(K_NO) || "[]") || []).forEach((x) => S.no.add(x));
} catch (e) {}

function savePools() {
  try {
    localStorage.setItem(K_POOLS, JSON.stringify(S.pools));
  } catch (e) {}
}
const isPick = (id) => typeof id === "string" && id.startsWith(PREFIX);
const libSongs = () => (P.songs || []).filter((s) => !isPick(s.id));

// ------------------------------------------------------------------ the device's pick storage
const db = (() => {
  let opening = null;
  const open = () =>
    opening ||
    (opening = new Promise((res, rej) => {
      const r = indexedDB.open("okMUSIC_picks", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("picks", { keyPath: "yt" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  const run = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction("picks", mode);
      const req = fn(t.objectStore("picks"));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = t.onabort = () => rej(t.error);
    });
  };
  return {
    get: (yt) => run("readonly", (st) => st.get(yt)),
    put: (o) => run("readwrite", (st) => st.put(o)),
    del: (yt) => run("readwrite", (st) => st.delete(yt)),
    keys: () => run("readonly", (st) => st.getAllKeys()),
  };
})();
db.keys()
  .then((k) => {
    k.forEach((x) => S.ready.add(x));
    redraw();
    pump();
  })
  .catch((e) => console.warn("picks storage unavailable", e));

// everything a pool / the radio still points at
function wanted() {
  const w = new Set();
  for (const k in S.pools) for (const v of S.pools[k].items || []) w.add(v.yt);
  if (S.radio) for (const v of S.radio.items) if (!v.own) w.add(v.yt);
  return w;
}
async function tidy() {
  if (S.ready.size <= KEEP_FILES) return;
  const w = wanted();
  const cur = P.currId && isPick(P.currId) ? P.currId.slice(PREFIX.length) : null;
  for (const yt of [...S.ready]) {
    if (S.ready.size <= KEEP_FILES) break;
    if (w.has(yt) || yt === cur) continue;
    S.ready.delete(yt);
    S.mem.delete(yt);
    await db.del(yt).catch(() => {});
  }
}

// ------------------------------------------------------------------ names + what you already have
function norm(s) {
  const f = window.finder && window.finder.api && window.finder.api.norm;
  return f ? f(s) : String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function cleanArtist(a) {
  return String(a || "").replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").replace(/\s*(official)?\s*$/i, "").trim();
}
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
// "Artist - Title" for a YouTube video (channel name as the artist when the title has none)
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
  const yts = new Map(), full = new Map(), titles = [];
  for (const s of libSongs()) {
    if (s.yt) yts.set(s.yt, s.id);
    full.set(norm(s.name), s.id);
    const p = split(s.name || "");
    const t = norm(p.title);
    if (t.length >= 3) titles.push({ t, a: norm(p.artist), id: s.id });
  }
  return { yts, full, titles };
}
// the id of your library song that IS this video, or null
function ownedId(v, keys) {
  if (keys.yts.has(v.yt)) return keys.yts.get(v.yt);
  const name = niceName(v);
  if (keys.full.has(norm(name))) return keys.full.get(norm(name));
  const p = split(name);
  const t = norm(p.title), a = norm(p.artist);
  if (!t) return null;
  const hit = keys.titles.find((x) => x.t === t && (!x.a || !a || x.a.includes(a.split(" ")[0]) || a.includes(x.a.split(" ")[0])));
  return hit ? hit.id : null;
}
// not a normal song: full albums, hour loops, mixes, reactions, type beats, shorts...
const JUNK = /\b(full album|album complet|full ep|\d+\s*(hour|hr)s?\b|1h\b|mix 20\d\d|playlist|compilation|nonstop|non-stop|live ?stream|reaction|reacting|type beat|karaoke|tutorial|podcast|interview|trailer|shorts|8d|nightcore|sped up|speed up|bass ?boosted)\b/i;
function okSong(v) {
  if (!v.yt || S.no.has(v.yt) || S.bad.has(v.yt)) return false;
  if (v.dur && (v.dur < 70 || v.dur > 600)) return false;
  return !JUNK.test(v.title || "");
}

// ------------------------------------------------------------------ folders (= Smart Shuffle "playlists")
function folderOf(id, list = window.libraryMgr.structure) {
  for (const it of list) {
    if (it.type !== "folder") continue;
    if ((it.items || []).some((x) => x.type === "song" && x.id === id)) return it;
    const f = folderOf(id, it.items || []);
    if (f) return f;
  }
  return null;
}
function findFolder(fid, list = window.libraryMgr.structure) {
  for (const it of list) {
    if (it.type !== "folder") continue;
    if (it.id === fid) return it;
    const f = findFolder(fid, it.items || []);
    if (f) return f;
  }
  return null;
}
function songsIn(folder) {
  const out = [];
  const scan = (l) => l.forEach((x) => (x.type === "song" ? out.push(x.id) : x.type === "folder" && scan(x.items || [])));
  scan(folder.items || []);
  return out.map((id) => P.songs.find((s) => s.id === id)).filter(Boolean);
}
function ctxSongs(key) {
  if (key === "root") return libSongs();
  const f = findFolder(key);
  return f ? songsIn(f) : [];
}
function ctxName(key) {
  if (key === "root") return "your library";
  const f = findFolder(key);
  return f ? f.name || "this folder" : "this folder";
}
// where the music is playing from right now (a pick keeps the folder it was picked for)
function ctxNow() {
  const id = P.currId;
  if (!id || isPick(id)) return S.ctx;
  const f = folderOf(id);
  return f ? f.id : "root";
}

// ------------------------------------------------------------------ finding picks
function seedSongs(key) {
  const pool = ctxSongs(key);
  if (!pool.length) return [];
  const want = pool.length >= 8 ? 4 : 3;
  const out = [];
  const add = (s) => s && !out.includes(s) && out.push(s);
  add(pool.find((s) => s.id === P.currId));
  // one of your most played songs from here (Wrapped stats), random from the top 5 so refresh changes it
  try {
    const st = JSON.parse(localStorage.getItem("okmusic_stats") || "null");
    const top = Object.entries((st && st.songs) || {})
      .sort((a, b) => b[1][0] - a[1][0])
      .map(([id]) => pool.find((s) => s.id === id))
      .filter(Boolean)
      .slice(0, 5);
    if (top.length) add(top[Math.floor(Math.random() * top.length)]);
  } catch (e) {}
  // random ones (songs that know their YouTube video first: no search needed)
  const rnd = [...pool].sort(() => Math.random() - 0.5).sort((a, b) => (b.yt ? 1 : 0) - (a.yt ? 1 : 0));
  for (const s of rnd) {
    if (out.length >= want) break;
    add(s);
  }
  return out;
}
async function videoOf(song) {
  if (song.yt) return song.yt;
  const p = split(song.name || "");
  const q = `${p.artist ? p.artist + " " : ""}${p.title} audio`;
  const r = await window.finder.api.call(`/search?n=1&q=${encodeURIComponent(q)}`);
  return r && r.results && r.results[0] && r.results[0].id;
}
async function mixOf(song, vid) {
  vid = vid || (await videoOf(song));
  if (!vid) return [];
  const url = `https://www.youtube.com/watch?v=${vid}&list=RD${vid}`;
  const l = await window.finder.api.call("/list?url=" + encodeURIComponent(url));
  const seed = split(song.name || "").title || song.name;
  return (l.tracks || [])
    .filter((t) => t.youtube && t.youtube !== vid)
    .map((t) => ({ yt: t.youtube, title: t.title || "", artist: t.artist || "", dur: t.duration || 0, seed }));
}

async function refill(key, quiet) {
  if (S.loading[key]) return;
  if (!window.finder || !window.finder.api) return;
  S.loading[key] = true;
  S.err[key] = "";
  redraw();
  try {
    if (!(await window.finder.api.ready())) throw new Error("the song servers aren't answering, try again in a bit");
    const seeds = seedSongs(key);
    if (!seeds.length) throw new Error("add a few songs first, Smart Shuffle finds songs LIKE yours");
    const lists = await Promise.all(seeds.map((s) => mixOf(s).catch((e) => (console.warn("smart shuffle mix failed", s.name, e), []))));
    const keys = libKeys();
    const seen = new Set(), names = new Set(), perArtist = {};
    const picks = [];
    // take turns between the mixes so the picks are a blend of all the seed songs
    for (let i = 0; i < 60; i++) {
      for (const l of lists) {
        const v = l[i];
        if (!v || seen.has(v.yt)) continue;
        seen.add(v.yt);
        if (!okSong(v) || ownedId(v, keys)) continue;
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
    // already-downloaded picks first (no waiting), the rest after
    picks.sort((a, b) => (S.ready.has(b.yt) ? 1 : 0) - (S.ready.has(a.yt) ? 1 : 0));
    S.pools[key] = { at: Date.now(), items: picks.slice(0, 40) };
    S.played.clear();
    savePools();
    if (!quiet) toast(`Smart Shuffle found ${S.pools[key].items.length} songs for ${ctxName(key)} ✨`, 2500);
  } catch (e) {
    S.err[key] = e.message || String(e);
    if (!quiet) toast("Smart Shuffle: " + S.err[key], 4000);
  } finally {
    S.loading[key] = false;
    redraw();
    pump();
    tidy();
  }
}
function ensurePool(key) {
  const p = S.pools[key];
  if (!p || !p.items || !p.items.length || Date.now() - p.at > FRESH_MS) refill(key, true);
  else pump();
}

// how many picks show in a folder: about 1 for every 3 of its songs (3..12)
function shown(key = S.ctx) {
  const p = S.pools[key];
  if (!p) return [];
  const n = ctxSongs(key).length;
  const k = Math.max(3, Math.min(12, Math.round(n / EVERY)));
  return p.items.slice(0, k);
}

// ------------------------------------------------------------------ downloading picks
async function download(v) {
  if (!(await window.finder.api.ready())) throw new Error("the song servers aren't answering");
  const f = await window.finder.api.fetchSong({ id: v.yt, name: niceName(v) });
  const art = (await window.finder.api.toDataUrl(`https://i.ytimg.com/vi/${v.yt}/mqdefault.jpg`)) || null;
  const got = { blob: f.blob, ext: f.ext, art };
  try {
    // raw bytes save everywhere (some iPhones refuse to store audio "files")
    await db.put({ yt: v.yt, bytes: await f.blob.arrayBuffer(), type: f.blob.type || "audio/mp4", ext: f.ext, art, at: Date.now() });
    S.ready.add(v.yt);
  } catch (e) {
    console.warn("couldn't keep the pick on the device", e);
  }
  return got;
}
// the pick's audio: memory -> device -> download
function getAudio(v) {
  if (S.mem.has(v.yt)) return Promise.resolve(S.mem.get(v.yt));
  // already downloading in the background: wait for that one
  if (S.jobs.has(v.yt))
    return S.jobs.get(v.yt).then((g) => {
      if (g) S.mem.set(v.yt, g);
      return g;
    });
  const job = (async () => {
    let got = null;
    if (S.ready.has(v.yt)) {
      const o = await db.get(v.yt).catch(() => null);
      if (o && o.bytes) got = { blob: new Blob([o.bytes], { type: o.type }), ext: o.ext, art: o.art };
      else S.ready.delete(v.yt);
    }
    if (!got) got = await download(v);
    S.mem.set(v.yt, got);
    // memory: only the few that are up next (they're all on the device anyway)
    while (S.mem.size > 4) {
      const old = [...S.mem.keys()].find((k) => PREFIX + k !== P.currId);
      if (!old) break;
      S.mem.delete(old);
    }
    return got;
  })();
  S.jobs.set(v.yt, job);
  job.then(
    () => S.jobs.delete(v.yt),
    () => S.jobs.delete(v.yt),
  );
  return job;
}
// background downloader: one at a time, radio's next songs first, then the folder's picks
function queueList() {
  const out = [];
  if (S.radio && S.radio.items) {
    let n = 0;
    for (let i = S.radio.idx + 1; i < S.radio.items.length && n < 4; i++) {
      const v = S.radio.items[i];
      if (v.own) continue;
      out.push(v);
      n++;
    }
  }
  if (S.on) out.push(...shown(S.ctx));
  return out.filter((v) => !S.ready.has(v.yt) && !S.bad.has(v.yt));
}
async function pump() {
  if (S.dl) return;
  const v = queueList()[0];
  if (!v) return warmNext();
  S.dl = v.yt;
  paintCard(v.yt);
  try {
    if (!S.jobs.has(v.yt)) {
      const job = download(v);
      S.jobs.set(v.yt, job);
      job.finally(() => S.jobs.delete(v.yt)).catch(() => {});
      await job;
    } else await S.jobs.get(v.yt);
  } catch (e) {
    console.warn("pick download failed", niceName(v), e);
    S.bad.add(v.yt);
  } finally {
    S.dl = null;
    paintCard(v.yt);
    warmNext();
    tidy();
    setTimeout(pump, 300);
  }
}
// load the very next pick (radio / smart shuffle) into memory, so "next" can play it instantly
function warmNext() {
  const v = radioUpcomingPick() || nextPick();
  if (v && S.ready.has(v.yt) && !S.mem.has(v.yt)) getAudio(v).catch(() => {});
}

// ------------------------------------------------------------------ playing picks
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
  if (!S.on) return null;
  return shown(S.ctx).find((v) => !S.played.has(v.yt) && PREFIX + v.yt !== P.currId && !S.bad.has(v.yt));
}
function playNow(v) {
  if (P.currId && !isPick(P.currId)) S.lastLibId = P.currId;
  const r = record(v, S.mem.get(v.yt));
  S.played.add(v.yt);
  S.sinceLast = 0;
  origPlay(r.id, null, false);
  window.ui.highlightActiveTrack(r.id);
  redraw();
  setTimeout(warmNext, 1500);
}
// "next" on a pick that's on the device: in memory = instant, else a quick read from the device
// (~0.1 s; if that somehow fails, the normal next song plays instead)
function playSoon(v) {
  if (S.mem.has(v.yt)) return playNow(v);
  getAudio(v).then(
    () => playNow(v),
    () => {
      S.bad.add(v.yt);
      libNext();
    },
  );
}
// tap on a pick: plays right away if it's on the device, else downloads it first
async function playPick(v) {
  if (!S.mem.has(v.yt)) {
    const fresh = !S.ready.has(v.yt);
    setBusy(v.yt, true);
    if (fresh) toast("Getting that song...", 2000);
    try {
      await getAudio(v);
    } catch (e) {
      toast("Couldn't get that song: " + e.message, 4000);
      return false;
    } finally {
      setBusy(v.yt, false);
    }
  }
  if (P.currId && !isPick(P.currId)) S.lastLibId = P.currId;
  playNow(v);
  return true;
}
function play(yt) {
  const v = (S.pools[S.ctx] && S.pools[S.ctx].items.find((x) => x.yt === yt)) || Object.values(S.pools).flatMap((p) => p.items || []).find((x) => x.yt === yt);
  if (v) return playPick(v);
}

// playing a song yourself from the library ends the radio + tells Smart Shuffle which folder you're in
const origPlay = P.play.bind(P);
P.play = function (id, contextList = null, renderList = true) {
  if (contextList && S.radio && !S.radio.loading) stopRadio(true);
  const r = origPlay(id, contextList, renderList);
  if (!isPick(id)) {
    const k = ctxNow();
    if (k !== S.ctx) {
      S.ctx = k;
      if (S.on) {
        ensurePool(k);
        redraw();
      }
    }
  }
  return r;
};
// "next song": the radio goes first, else while Smart Shuffle is on every 3rd song is a pick
// (only one that's already loaded, so Auto DJ's crossfade never waits)
const origNext = P.next.bind(P);
P.next = function () {
  if (S.radio && !S.radio.loading && !(P.queue && P.queue.length)) return radioNext();
  const cur = P.currId;
  if (!S.on || !P.shuffle || (P.queue && P.queue.length)) return origNext();
  if (!isPick(cur)) {
    S.lastLibId = cur;
    S.sinceLast++;
  }
  const v = S.sinceLast >= EVERY - 1 && nextPick();
  if (v && (S.mem.has(v.yt) || S.ready.has(v.yt))) return playSoon(v);
  warmNext();
  return origNext();
};
// the normal next song; after a pick (not in your list) it continues from your last own song
function libNext() {
  if (isPick(P.currId) && !P.shuffle && S.lastLibId) P.currId = S.lastLibId;
  return origNext();
}
const origPrev = P.prev.bind(P);
P.prev = function () {
  if (S.radio && !S.radio.loading && S.radio.idx > 0) return radioJump(S.radio.idx - 1);
  if (S.radio && S.radio.idx === 0 && S.radio.seedId && P.songs.some((s) => s.id === S.radio.seedId)) {
    S.radio.idx = -1;
    redraw();
    return origPlay(S.radio.seedId, null, false);
  }
  // "previous" on a pick goes back to the library song before it
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

// ------------------------------------------------------------------ song radio
async function startRadio(id) {
  const song = (P.songs || []).find((s) => s.id === id);
  if (!song) return toast("Play a song first, then hit radio");
  if (!window.finder || !window.finder.api) return;
  const seedName = split(song.name || "").title || song.name;
  S.radio = { seed: seedName, seedId: id, items: [], idx: -1, loading: true, all: false };
  paintRadioBtn();
  redraw();
  toast(`Starting ${seedName} radio 📻`, 2000);
  if (P.currId !== id) origPlay(id, null, false), window.ui.highlightActiveTrack(id);
  try {
    if (!(await window.finder.api.ready())) throw new Error("the song servers aren't answering, try again in a bit");
    const vid = await videoOf(song);
    if (!vid) throw new Error("couldn't find that song on YouTube");
    const raw = await mixOf(song, vid);
    if (!S.radio || S.radio.seedId !== id) return; // stopped meanwhile
    const keys = libKeys();
    const names = new Set([norm(song.name)]);
    const items = [];
    for (const v of raw) {
      if (!okSong(v)) continue;
      const nm = norm(niceName(v));
      if (names.has(nm)) continue;
      names.add(nm);
      const own = ownedId(v, keys);
      if (own === id) continue;
      items.push({ ...v, own });
    }
    if (!items.length) throw new Error("YouTube gave no songs for that one");
    S.radio.items = items;
    S.radio.loading = false;
    const mine = items.filter((v) => v.own).length;
    toast(`${seedName} radio: ${items.length} songs${mine ? ` (${mine} you already have)` : ""} 📻`, 3000);
  } catch (e) {
    toast("Radio: " + (e.message || e), 4000);
    S.radio = null;
  }
  paintRadioBtn();
  redraw();
  pump();
}
function stopRadio(quiet) {
  if (!S.radio) return;
  S.radio = null;
  paintRadioBtn();
  redraw();
  if (!quiet) toast("Radio off", 1500);
}
function radioUpcomingPick() {
  const r = S.radio;
  if (!r || r.loading) return null;
  for (let i = r.idx + 1; i < r.items.length; i++) if (!r.items[i].own) return r.items[i];
  return null;
}
async function radioJump(i) {
  const r = S.radio;
  const v = r && r.items[i];
  if (!v) return;
  if (v.own && P.songs.some((s) => s.id === v.own)) {
    r.idx = i;
    origPlay(v.own, null, false);
    window.ui.highlightActiveTrack(v.own);
    redraw();
  } else {
    const prev = r.idx;
    r.idx = i;
    if (!(await playPick(v))) r.idx = prev;
  }
  setTimeout(pump, 500);
}
function radioNext() {
  const r = S.radio;
  for (let i = r.idx + 1; i < r.items.length; i++) {
    const v = r.items[i];
    if (v.own && P.songs.some((s) => s.id === v.own)) {
      r.idx = i;
      origPlay(v.own, null, false);
      window.ui.highlightActiveTrack(v.own);
      redraw();
      setTimeout(pump, 500);
      return;
    }
    if (S.mem.has(v.yt) || S.ready.has(v.yt)) {
      r.idx = i;
      playSoon(v);
      setTimeout(pump, 500);
      return;
    }
    // this one isn't downloaded yet (or failed): skip it, the radio never waits for the internet
  }
  if (r.items.slice(r.idx + 1).some((v) => !S.bad.has(v.yt))) {
    // radio songs still downloading: one of yours in between, the radio keeps going after
    toast("Radio songs are still downloading, one of yours meanwhile", 2500);
    return libNext();
  }
  toast("Radio's over, back to your library", 2500);
  stopRadio(true);
  libNext();
}
// library radio button: radio of the song playing (tap again = off)
function radioBtn() {
  if (S.radio) return stopRadio();
  if (!P.currId) return toast("Play a song first, then hit radio");
  startRadio(P.currId);
}
function paintRadioBtn() {
  const b = $("radioBtn");
  if (b) b.classList.toggle("active", !!S.radio);
}

// ------------------------------------------------------------------ keep / hide
async function keep(yt) {
  const all = [...Object.values(S.pools).flatMap((p) => p.items || []), ...(S.radio ? S.radio.items : [])];
  const v = all.find((x) => x.yt === yt);
  if (!v) return;
  // a Smart Shuffle pick goes into the folder it was picked for
  const key = Object.keys(S.pools).find((k) => (S.pools[k].items || []).some((x) => x.yt === yt));
  setBusy(yt, true);
  try {
    const got = await getAudio(v);
    const id = await window.finder.api.saveSong({ blob: got.blob, ext: got.ext, vid: v.yt, title: niceName(v), art: got.art, meta: { name: niceName(v), duration: v.dur } });
    const folder = key && key !== "root" ? findFolder(key) : null;
    if (folder) {
      folder.items.push({ type: "song", id });
      window.libraryMgr.save();
    }
    for (const k in S.pools) S.pools[k].items = (S.pools[k].items || []).filter((x) => x.yt !== yt);
    savePools();
    if (S.radio) S.radio.items.forEach((x) => x.yt === yt && (x.own = id));
    S.ready.delete(yt);
    S.mem.delete(yt);
    db.del(yt).catch(() => {});
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
    toast(`Added "${split(niceName(v)).title}" to ${folder ? folder.name : "your library"} ✅`, 2500);
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
  for (const k in S.pools) S.pools[k].items = (S.pools[k].items || []).filter((x) => x.yt !== yt);
  if (S.radio) {
    const i = S.radio.items.findIndex((x) => x.yt === yt);
    if (i > S.radio.idx) S.radio.items.splice(i, 1);
  }
  S.mem.delete(yt);
  if (S.ready.delete(yt)) db.del(yt).catch(() => {});
  savePools();
  redraw();
  pump();
  toast("Got it, won't suggest that one again", 2000);
}

// ------------------------------------------------------------------ the library list
function setBusy(yt, on) {
  document.querySelectorAll(`[data-yt="${yt}"]`).forEach((c) => c.classList.toggle("ss-busy", on));
}
// "downloading..." / not ready yet look, without redrawing the whole list
function paintCard(yt) {
  document.querySelectorAll(`[data-yt="${yt}"]`).forEach((c) => {
    c.classList.toggle("ss-wait", !S.ready.has(yt));
    c.classList.toggle("ss-dl", S.dl === yt);
  });
  const h = document.querySelector(".ss-head");
  if (h && S.on) h.replaceWith(head(S.ctx)); // "2/4 ready"
}
function pickRow(v, opts = {}) {
  const id = PREFIX + v.yt;
  const p = split(niceName(v));
  const c = document.createElement("div");
  c.className = (opts.radio ? "radio-row" : "lib-card group") + " ss-card" + (!opts.radio && P.currId === id ? " active" : "");
  if (!opts.radio) c.dataset.id = id;
  c.dataset.yt = v.yt;
  c.draggable = false;
  const why = opts.why != null ? opts.why : v.seed ? "because of " + esc(v.seed) : "Smart Shuffle";
  c.innerHTML = `
    <div class="lib-card-icon has-art" style="background-image:url('https://i.ytimg.com/vi/${encodeURIComponent(v.yt)}/mqdefault.jpg')"><i class="ss-spin fa-solid fa-spinner fa-spin"></i></div>
    <div class="lib-card-info">
      <div class="lib-card-title">${esc(p.title)}</div>
      ${p.artist ? `<div class="lib-card-artist">${esc(p.artist)}</div>` : ""}
      <div class="ss-why"><i class="fa-solid fa-wand-magic-sparkles"></i> <span class="ss-why-t">${why}</span><span class="ss-dl-t"><i class="fa-solid fa-arrow-down"></i> downloading...</span></div>
    </div>
    <div class="ss-acts">
      <button type="button" class="ss-add" title="Add to your library"><i class="fa-solid fa-plus"></i></button>
      <button type="button" class="ss-no" title="Not for me (won't suggest it again)"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
  c.classList.toggle("ss-wait", !S.ready.has(v.yt));
  c.classList.toggle("ss-dl", S.dl === v.yt);
  c.onclick = opts.onPlay || (() => playPick(v));
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
function head(key) {
  const h = document.createElement("div");
  h.className = "ss-head";
  const n = shown(key).length;
  const ready = shown(key).filter((v) => S.ready.has(v.yt)).length;
  const where = key === "root" ? "" : ` for ${esc(ctxName(key))}`;
  const txt = S.loading[key]
    ? `<i class="fa-solid fa-spinner fa-spin"></i> finding songs${where}...`
    : S.err[key] && !n
      ? `<i class="fa-solid fa-triangle-exclamation"></i> ${esc(S.err[key])}`
      : `<i class="fa-solid fa-wand-magic-sparkles"></i> Smart Shuffle: ${n} new song${n === 1 ? "" : "s"}${where}${ready < n ? ` · ${ready}/${n} ready` : ""}`;
  h.innerHTML = `<span>${txt}</span><button type="button" title="New picks"${S.loading[key] ? " disabled" : ""}><i class="fa-solid fa-rotate"></i></button>`;
  h.querySelector("button").onclick = () => refill(key, false);
  return h;
}
// mixes the picks into the list that's playing: one after every 3 of its items
function weave(box, key) {
  const items = [...box.children].filter((c) => c.classList.contains("lib-card") || c.classList.contains("lib-folder"));
  if (!items.length) return;
  items[0].before(head(key));
  const picks = shown(key);
  let k = 0;
  for (let i = EVERY - 1; i < items.length && k < picks.length; i += EVERY) items[i].after(pickRow(picks[k++]));
  const last = items[items.length - 1];
  let at = last.nextElementSibling && last.nextElementSibling.classList.contains("ss-card") ? last.nextElementSibling : last;
  while (k < picks.length) {
    const c = pickRow(picks[k++]);
    at.after(c);
    at = c;
  }
}
function radioBox() {
  const r = S.radio;
  const box = document.createElement("div");
  box.className = "radio-box";
  const total = r.items.length;
  const left = Math.max(0, total - r.idx - 1);
  box.innerHTML = `
    <div class="radio-top">
      <span class="radio-ic"><i class="fa-solid fa-tower-broadcast"></i></span>
      <span class="radio-txt"><b>${esc(r.seed)} Radio</b><small>${r.loading ? `<i class="fa-solid fa-spinner fa-spin"></i> finding songs like it...` : `${left} songs up next · new ones download by themselves`}</small></span>
      <button type="button" class="radio-stop" title="Stop the radio"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="radio-list"></div>`;
  box.querySelector(".radio-stop").onclick = () => stopRadio();
  const list = box.querySelector(".radio-list");
  const from = Math.max(0, r.idx);
  const upto = r.all ? total : Math.min(total, from + 6);
  for (let i = from; i < upto; i++) {
    const v = r.items[i];
    const now = i === r.idx;
    let row;
    if (v.own) {
      const s = P.songs.find((x) => x.id === v.own);
      const p = split((s && s.name) || niceName(v));
      row = document.createElement("div");
      row.className = "radio-row radio-own";
      row.innerHTML = `
        <div class="lib-card-icon has-art" style="background-image:url('${s && s.art ? esc(s.art) : `https://i.ytimg.com/vi/${encodeURIComponent(v.yt)}/mqdefault.jpg`}')"></div>
        <div class="lib-card-info"><div class="lib-card-title">${esc(p.title)}</div>${p.artist ? `<div class="lib-card-artist">${esc(p.artist)}</div>` : ""}
        <div class="ss-why own"><i class="fa-solid fa-check"></i> in your library</div></div>`;
      row.onclick = () => radioJump(i);
    } else row = pickRow(v, { radio: true, why: "new for you", onPlay: () => radioJump(i) });
    row.classList.toggle("now", now);
    list.appendChild(row);
  }
  if (!r.loading && upto < total) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "radio-more";
    more.textContent = `show all ${total - from} songs`;
    more.onclick = () => {
      r.all = true;
      redraw();
    };
    list.appendChild(more);
  }
  return box;
}
function decorate(filterText) {
  const el = $("libraryList");
  if (!el || filterText || (window.ui && window.ui.selectMode)) return;
  if (S.radio) {
    const first = [...el.children].find((c) => c.classList.contains("lib-card") || c.classList.contains("lib-folder"));
    if (first) first.before(radioBox());
    else el.appendChild(radioBox());
  }
  if (!S.on) return;
  if (S.ctx === "root") return weave(el, "root");
  const f = document.getElementById("folder-" + S.ctx);
  const inner = f && f.querySelector(":scope > .lib-folder-content > .lib-folder-inner");
  if (inner) weave(inner, S.ctx);
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
  if (v) {
    S.ctx = ctxNow();
    ensurePool(S.ctx);
  }
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
    toast(`Smart Shuffle on ✨ new songs like ${ctxName(S.ctx)} get mixed in, + keeps one`, 3500);
  } else {
    P.shuffle = false;
    setOn(false);
    toast("Shuffle off", 1500);
  }
};
if (S.on) {
  P.shuffle = true;
  paintBtn();
  // first load: fresh picks for the folder you were in (quietly, in the background)
  setTimeout(() => {
    S.ctx = ctxNow();
    ensurePool(S.ctx);
    redraw();
  }, 3000);
}
redraw(); // the library was probably drawn before this file loaded

window.smartShuffle = {
  get on() { return S.on; },
  get ctx() { return S.ctx; },
  get pools() { return S.pools; },
  get radioState() { return S.radio; },
  get ready() { return S.ready; },
  get downloading() { return S.dl; },
  refill: () => refill(S.ctx, false),
  play,
  keep,
  hide,
  set: setOn,
  radio: startRadio,
  stopRadio,
  radioBtn,
};
