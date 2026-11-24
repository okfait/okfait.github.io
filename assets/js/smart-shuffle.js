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
  // v2.28.0: picks found the old way (unverified seed -> meditation videos) are thrown away once
  for (const k in S.pools) if (!S.pools[k] || S.pools[k].v !== 2) delete S.pools[k];
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
const JUNK = /\b(full album|album complet|full ep|\d+\s*(hour|hr)s?\b|1h\b|mix 20\d\d|playlist|compilation|nonstop|non-stop|live ?stream|reaction|reacting|type beat|karaoke|tutorial|podcast|interview|trailer|shorts|8d|nightcore|sped up|speed up|bass ?boosted|\d+\s*hz|frequency|meditation|healing|chakra|activation|binaural|asmr|affirmations?|audiobook|audio book|sleep music|relaxing)\b/i;
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
// v2.28.0: the RIGHT video for one of your songs. Before: searched "<name> audio" and took result #1
// blindly ("awaken Sufletu' audio" = meditation videos -> the whole mix was yoga music).
// Now: "Artist - Title", 8 results, the title words AND the artist must match, else no seed.
const vidMemo = {};
async function videoOf(song) {
  if (song.yt) return song.yt;
  if (song.id in vidMemo) return vidMemo[song.id];
  const p = split(cleanTitle(song.name || ""));
  const title = norm(p.title), artist = norm(p.artist);
  if (!title) return null;
  const q = p.artist ? `${p.artist} - ${p.title}` : p.title;
  const r = await window.finder.api.call(`/search?n=8&q=${encodeURIComponent(q)}`);
  let best = null, bs = 0;
  for (const x of (r && r.results) || []) {
    if (JUNK.test(x.title || "")) continue;
    const t = norm(x.title), c = norm(x.channel);
    const tw = title.split(" ").filter((w) => w.length > 1);
    let sc = tw.length && tw.every((w) => t.includes(w)) ? 3 : 0;
    if (artist) sc += t.includes(artist) || c.includes(artist) ? 3 : 0;
    else sc += 1;
    if (x.duration && (x.duration < 60 || x.duration > 600)) sc -= 3;
    if (sc > bs) (bs = sc), (best = x);
  }
  const id = best && bs >= (artist ? 6 : 4) ? best.id : null;
  vidMemo[song.id] = id;
  if (id && song.blob && !isPick(song.id)) {
    song.yt = id; // remember it (no search next time)
    window.player.db.update(song.id, { yt: id }).catch(() => {});
  }
  return id;
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
// artists in a name: "awaken x Gorby - MESSI (feat. Sp!ce)" -> awaken, gorby, sp ce
const SEP = /\s+(?:x|&|\+|feat\.?|ft\.?|featuring|with|si|și|vs\.?)\s+|\s*[,&+]\s*/i;
const NOT_ARTIST = /^(official|music|records?|production|productions|tv|topic|lyrics?|video)$/;
function artistsOf(v) {
  const p = split(niceName(v));
  const feat = (p.title.match(/[([]\s*(?:feat|ft)\.?\s*([^)\]]+)/i) || p.title.match(/(?:feat|ft)\.?\s+([^([]+)/i) || [])[1] || "";
  const raw = [...String(p.artist || "").split(SEP), ...feat.split(SEP)];
  return [...new Set(raw.map(norm).filter((a) => a.length >= 2 && !NOT_ARTIST.test(a)))];
}
// v2.28.0 the "artist web" (what the user asked for): YouTube's mix of a song starts with that artist +
// their collabs, then drifts into random global hits (eminem, finnish rap...). So only songs CONNECTED
// to your artists are kept: by your artists, or by someone who made a song with them, or with THEM.
// Collab videos found on the way get their own mix read too (= the collaborators' collaborators).
async function artistWeb(seeds, startArtists, expand, perArtist = 4) {
  // artist -> {o: which of your artists it leads back to, d: 0 yours, 1 worked with yours, 2 worked with them}
  // (max 2 jumps: a 3rd jump is where name twins leak in, like the romanian IDK -> the US IDK -> Eminem)
  const G = new Map();
  for (const a of startArtists) G.set(a, { o: a, d: 0 });
  const vids = (await Promise.all(seeds.map((s) => videoOf(s).catch(() => null)))).filter(Boolean);
  const lists = await Promise.all(seeds.map((s) => mixOf(s).catch(() => [])));
  const got = new Map(), tried = new Set(vids);
  const walk = (list) => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const v of list) {
        if (got.has(v.yt)) continue;
        const as = artistsOf(v);
        let link = null;
        for (const a of as) if (G.has(a) && (!link || G.get(a).d < G.get(link).d)) link = a;
        if (!link) continue;
        const L = G.get(link);
        for (const a of as) if (!G.has(a) && L.d + 1 <= 2) G.set(a, { o: L.o, d: L.d + 1 });
        v.why = L.d === 0 ? `more from ${link}` : `${link} · works with ${L.o}`;
        v.hop = L.d;
        v.main = as[0] || link;
        got.set(v.yt, v);
        changed = true;
      }
    }
  };
  lists.forEach(walk);
  // the collaborators' own mixes (collab videos first)
  const next = [...got.values()].filter((v) => artistsOf(v).length >= 2 && !tried.has(v.yt)).slice(0, expand);
  next.forEach((v) => tried.add(v.yt));
  const more = await Promise.all(next.map((v) => mixOf({ name: niceName(v) }, v.yt).catch(() => [])));
  more.forEach(walk);
  lists.forEach(walk); // songs earlier in the first mixes may connect now
  let out = [...got.values()];
  // tiny artist with almost nothing connected: YouTube's first few picks are still close, use those
  if (out.length < 6)
    for (const l of lists) for (const v of l.slice(0, 8)) if (!got.has(v.yt)) got.set(v.yt, { ...v, why: "close to " + v.seed, hop: 2, main: artistsOf(v)[0] || "" });
  out = [...got.values()];
  // blend: take turns between artists (closest ones first), max perArtist songs each,
  // so one artist with 30 songs doesn't flood it
  const groups = new Map();
  out.sort((x, y) => x.hop - y.hop).forEach((v) => {
    const k = v.main;
    if (!groups.has(k)) groups.set(k, []);
    if (groups.get(k).length < perArtist) groups.get(k).push(v);
  });
  const lanes = [...groups.values()];
  const mixed = [];
  for (let i = 0; i < perArtist; i++) for (const l of lanes) if (l[i]) mixed.push(l[i]);
  return mixed;
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
    // every artist in the folder counts as "yours" (the folder's vibe)
    const mine = [...new Set(ctxSongs(key).flatMap((s) => artistsOf({ title: s.name, artist: "" })))];
    const lists = [await artistWeb(seeds, mine, 4, 3)];
    const keys = libKeys();
    const seen = new Set(), names = new Set(), perArtist = {};
    const picks = [];
    // take turns between the mixes so the picks are a blend of all the seed songs
    for (let i = 0; i < 200; i++) {
      for (const l of lists) {
        const v = l[i];
        if (!v || seen.has(v.yt)) continue;
        seen.add(v.yt);
        if (!okSong(v) || ownedId(v, keys)) continue;
        const nm = norm(niceName(v));
        if (names.has(nm)) continue; // same song, another upload
        const a = artistsOf(v)[0] || norm(v.artist);
        if ((perArtist[a] || 0) >= 3) continue; // not 10 songs of the same artist
        perArtist[a] = (perArtist[a] || 0) + 1;
        names.add(nm);
        picks.push(v);
      }
    }
    if (!picks.length) throw new Error("couldn't find new songs right now, try refresh in a bit");
    // already-downloaded picks first (no waiting), the rest after
    picks.sort((a, b) => (S.ready.has(b.yt) ? 1 : 0) - (S.ready.has(a.yt) ? 1 : 0));
    S.pools[key] = { v: 2, at: Date.now(), items: picks.slice(0, 40) };
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
  renderQ();
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
  if (S.plan && !S.fromPlan) {
    // played it yourself: its next spot in Up Next goes away (later rounds keep it)
    const i = S.plan.findIndex((e) => e.id === id);
    if (i >= 0) S.plan.splice(i, 1);
  }
  setTimeout(renderQ, 0);
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
  if (P.shuffle && !(window.smartQueue && window.smartQueue.on)) return planNext();
  const v = S.sinceLast >= EVERY - 1 && nextPick();
  if (v && (S.mem.has(v.yt) || S.ready.has(v.yt))) return playSoon(v);
  warmNext();
  return origNext();
};

// ------------------------------------------------------------------ Up Next (v2.28.0)
// Shuffle order is decided AHEAD now (like Spotify), so the Queue can show the next songs.
// Smart Shuffle picks sit in it after every 2 of your songs.
S.plan = [];
S.planKey = "";
function baseList() {
  const l = P.playlist && P.playlist.length ? P.playlist : window.ui.getFlatList();
  return l.filter((id) => !isPick(id) && P.songs.some((s) => s.id === id));
}
function makePlan() {
  const l = baseList();
  const key = l.join(",") + "|" + (S.on ? S.ctx : "");
  if (key !== S.planKey) {
    S.planKey = key;
    S.plan = [];
    S.planCount = 0;
  }
  if (!l.length) return S.plan;
  // keep at least 12 songs decided ahead: rounds of your songs in random order (no repeat until
  // every song played), a Smart Shuffle pick after every 2 of yours
  const inPlan = () => new Set(S.plan.filter((e) => e.pick).map((e) => e.pick.yt));
  while (S.plan.length < 12) {
    const used = new Set(S.plan.filter((e) => e.id).map((e) => e.id));
    let ids = l.filter((id) => !used.has(id) && id !== P.currId);
    if (!ids.length) ids = l.filter((id) => id !== (S.plan.length ? S.plan[S.plan.length - 1].id : P.currId));
    if (!ids.length) ids = [...l];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    for (const id of ids) {
      S.plan.push({ id });
      S.planCount = (S.planCount || 0) + 1;
      if (S.on && S.planCount % (EVERY - 1) === 0) {
        const have = inPlan();
        const v = shown(S.ctx).find((x) => !S.played.has(x.yt) && !have.has(x.yt) && PREFIX + x.yt !== P.currId && !S.bad.has(x.yt));
        if (v) S.plan.push({ pick: v });
      }
      if (S.plan.length >= 12) break;
    }
  }
  return S.plan;
}
function planNext() {
  makePlan();
  if (P.currId && !isPick(P.currId)) S.lastLibId = P.currId;
  while (S.plan.length) {
    const e = S.plan.shift();
    if (e.pick) {
      if (S.mem.has(e.pick.yt) || S.ready.has(e.pick.yt)) return playSoon(e.pick), renderQ();
      continue; // not downloaded yet: skip it, never wait
    }
    if (P.songs.some((s) => s.id === e.id)) {
      S.fromPlan = true;
      try {
        P.play(e.id);
      } finally {
        S.fromPlan = false;
      }
      return renderQ();
    }
  }
  return origNext();
}
// the next songs, for the Queue panel
function upcoming(n = 10) {
  const out = [];
  const lib = (id) => P.songs.find((s) => s.id === id);
  const add = (o) => out.length < n && out.push(o);
  if (S.radio && !S.radio.loading) {
    for (let i = S.radio.idx + 1; i < S.radio.items.length && out.length < n; i++) {
      const v = S.radio.items[i];
      const s = v.own && lib(v.own);
      add(s ? { name: s.name, art: s.art, sub: "radio · in your library", play: () => radioJump(i) } : { name: niceName(v), art: `https://i.ytimg.com/vi/${v.yt}/mqdefault.jpg`, sub: "radio · new for you", pick: true, play: () => radioJump(i) });
    }
    return { label: `${S.radio.seed} Radio`, items: out };
  }
  if (window.smartQueue && window.smartQueue.on) return { label: "Smart Queue picks by speed", items: [] };
  if (P.shuffle) {
    makePlan().forEach((e, i) => {
      if (e.pick) add({ name: niceName(e.pick), art: `https://i.ytimg.com/vi/${e.pick.yt}/mqdefault.jpg`, sub: e.pick.why || "Smart Shuffle", pick: true, play: () => jumpPlan(i) });
      else {
        const s = lib(e.id);
        if (s) add({ name: s.name, art: s.art, sub: "", play: () => jumpPlan(i) });
      }
    });
    return { label: S.on ? "Smart Shuffle" : "Shuffle", items: out };
  }
  const l = baseList();
  const at = l.indexOf(P.currId);
  for (let i = 1; i <= l.length - 1 && out.length < n; i++) {
    const s = lib(l[(at + i + l.length) % l.length]);
    if (s) add({ name: s.name, art: s.art, sub: "", play: () => P.play(s.id) });
  }
  return { label: "In order", items: out };
}
function jumpPlan(i) {
  S.plan.splice(0, i); // skip the ones before it
  planNext();
}
const origRenderQ = window.ui.renderQueue.bind(window.ui);
function renderQ() {
  try {
    window.ui.renderQueue();
  } catch (e) {}
}
window.ui.renderQueue = function () {
  origRenderQ();
  const list = $("queueList");
  if (!list) return;
  const up = upcoming(10);
  if (!P.queue.length) list.innerHTML = ""; // drop "Queue is empty", Next up is below
  const h = document.createElement("div");
  h.className = "q-next-h";
  h.innerHTML = `<span>Next up</span><small>${esc(up.label)}</small>`;
  list.appendChild(h);
  if (!up.items.length) {
    const e = document.createElement("div");
    e.className = "text-[10px] text-white/30 text-center uppercase tracking-widest mt-2";
    e.textContent = P.songs.length ? "decided when the song ends" : "add some songs first";
    list.appendChild(e);
  }
  up.items.forEach((it, i) => {
    const r = document.createElement("div");
    r.className = "q-next" + (it.pick ? " pick" : "");
    const p = split(it.name || "");
    r.innerHTML = `<span class="q-n">${i + 1}</span><div class="q-art"${it.art ? ` style="background-image:url('${esc(it.art)}')"` : ""}></div><div class="q-t"><b>${esc(p.title)}</b><span>${esc([p.artist, it.sub].filter(Boolean).join(" · "))}</span></div>`;
    r.onclick = () => it.play();
    list.appendChild(r);
  });
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
  try {
    if (P.currId !== id) origPlay(id, null, false), window.ui.highlightActiveTrack(id);
    if (!(await window.finder.api.ready())) throw new Error("the song servers aren't answering, try again in a bit");
    const vid = await videoOf(song);
    if (!vid) throw new Error("couldn't find that song on YouTube");
    const raw = await artistWeb([song], artistsOf({ title: song.name, artist: "" }), 6);
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
  const why = opts.why != null ? opts.why : v.why ? esc(v.why) : v.seed ? "because of " + esc(v.seed) : "Smart Shuffle";
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
    } else row = pickRow(v, { radio: true, why: v.why ? esc(v.why) : "new for you", onPlay: () => radioJump(i) });
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
  _web: (songs, artists, n) => artistWeb(songs, artists, n), // for testing
  _artists: (name) => artistsOf({ title: name, artist: "" }),
};
