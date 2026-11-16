// okMUSIC v2.17.0 "no install" mode for Add Songs.
//
// When the PC helper isn't running, Add Songs talks to free public Invidious servers
// (YouTube mirrors other people run). They search YouTube and hand the song's audio
// straight to your browser, so nothing has to be installed. They're run by volunteers:
// they can be slow or go down, so we keep a list and use whichever one answers.
//
// This file pretends to be the helper: same paths (/search, /match, /list, /download...),
// same answers, so song-finder.js doesn't care which one it's talking to.

const KNOWN = ["https://yt.chocolatemoo53.com"]; // worked on 2026-11-16
const LIST_URL = "https://api.invidious.io/instances.json?sort_by=type,users";
const KEY_GOOD = "okmusic_inv_good";
const KEY_LIST = "okmusic_inv_list";

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
      localStorage.setItem(k, v);
    } catch (e) {}
  },
};

async function getJson(url, timeout = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------------------------------------------ which servers
let listCache = null;
async function instances() {
  if (listCache) return listCache;
  let extra = [];
  const saved = JSON.parse(ls.get(KEY_LIST) || "null");
  if (saved && Date.now() - saved.t < 86400000) extra = saved.list;
  else {
    try {
      const d = await getJson(LIST_URL, 8000);
      extra = d.filter((x) => x[1] && x[1].api && x[1].type === "https").map((x) => x[1].uri.replace(/\/+$/, ""));
      ls.set(KEY_LIST, JSON.stringify({ t: Date.now(), list: extra }));
    } catch (e) {
      /* list site down: the known ones still work */
    }
  }
  const good = ls.get(KEY_GOOD);
  listCache = [...new Set([good, ...KNOWN, ...extra].filter(Boolean))];
  return listCache;
}

// asks the servers one by one until one answers, then sticks with that one
async function inv(path, timeout) {
  const list = await instances();
  let lastErr = null;
  for (const base of list) {
    try {
      const j = await getJson(base + path, timeout);
      if (j && j.error) throw new Error(j.error);
      if (base !== list[0]) {
        list.splice(list.indexOf(base), 1);
        list.unshift(base);
      }
      ls.set(KEY_GOOD, base);
      return j;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("the free YouTube servers aren't answering right now" + (lastErr ? ` (${lastErr.message})` : ""));
}

let pingAt = 0, pingOk = false;
export async function ping() {
  if (Date.now() - pingAt < 5 * 60000) return pingOk;
  try {
    const j = await inv("/api/v1/videos/dQw4w9WgXcQ?fields=title", 8000);
    pingOk = !!(j && j.title);
  } catch (e) {
    pingOk = false;
  }
  pingAt = Date.now();
  return pingOk;
}

// ------------------------------------------------------------------ matching (same rules as the helper)
const JUNK = /\((official|lyric|lyrics|audio|video|visuali[sz]er|hd|hq|4k|remaster(ed)?[^)]*)[^)]*\)|\[(official|lyric|lyrics|audio|video|visuali[sz]er|hd|hq|4k)[^\]]*\]/gi;
function words(s) {
  return (s || "")
    .replace(JUNK, " ")
    .toLowerCase()
    .replace(/\b(feat|ft|featuring|prod)\b\.?/g, " ")
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((w) => w.length > 1) || [];
}
function score(e, query, wantDur) {
  const q = new Set(words(query));
  const t = new Set(words(e.title + " " + e.channel));
  let s = ([...q].filter((w) => t.has(w)).length / Math.max(1, q.size)) * 10;
  const title = e.title.toLowerCase();
  for (const bad of ["live", "cover", "karaoke", "instrumental", "8d", "nightcore", "reverb", "slowed", "sped up", "remix", "1 hour", "10 hours"])
    if (title.includes(bad) && !query.toLowerCase().includes(bad)) s -= 4;
  if (/topic/i.test(e.channel)) s += 2;
  if (wantDur && e.duration) {
    const d = Math.abs(e.duration - wantDur);
    s += d <= 3 ? 4 : d <= 10 ? 2 : d > 40 ? -2 : 0;
  }
  if (e.duration && (e.duration < 45 || e.duration > 900)) s -= 5;
  return s;
}

async function search(q, n = 6) {
  const res = await inv(`/api/v1/search?type=video&q=${encodeURIComponent(q)}`);
  return (res || [])
    .filter((v) => v.type === "video" && v.videoId && !v.liveNow)
    .slice(0, n)
    .map((v) => ({
      id: v.videoId,
      title: v.title || "",
      channel: v.author || "",
      duration: v.lengthSeconds || 0,
      thumb: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
    }));
}
async function bestMatch(q, dur) {
  const found = await search(q + " audio", 8);
  if (!found.length) throw new Error("no results on YouTube for: " + q);
  return found.reduce((a, b) => (score(b, q, dur) > score(a, q, dur) ? b : a));
}

// ------------------------------------------------------------------ audio
const urlCache = new Map(); // id -> { url, title, at }
async function audioInfo(id) {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id || "")) throw new Error("bad video id");
  const hit = urlCache.get(id);
  if (hit && Date.now() - hit.at < 30 * 60000) return hit;
  // local=true = the server passes the audio through itself (YouTube locks its links to one IP)
  const v = await inv(`/api/v1/videos/${id}?local=true&fields=title,author,adaptiveFormats`);
  const fm = (v.adaptiveFormats || []).filter((f) => /^audio\//.test(f.type || ""));
  // m4a first (plays everywhere, iPhone included), best quality first
  fm.sort((a, b) => (/mp4/.test(b.type) - /mp4/.test(a.type)) || (+b.bitrate || 0) - (+a.bitrate || 0));
  if (!fm.length) throw new Error("that video has no audio the server can give");
  const f = fm[0];
  const info = { url: f.url, ext: /mp4/.test(f.type) ? "m4a" : "webm", title: v.title || "", at: Date.now() };
  urlCache.set(id, info);
  return info;
}
export async function previewUrl(id) {
  return (await audioInfo(id)).url;
}
async function download(id) {
  const info = await audioInfo(id);
  const r = await fetch(info.url);
  if (!r.ok) {
    urlCache.delete(id);
    throw new Error("the free server didn't give the song (HTTP " + r.status + "), try again");
  }
  const blob = await r.blob();
  return { blob, ext: info.ext, title: info.title };
}

// ------------------------------------------------------------------ lists
async function youtubeList(url) {
  const id = (url.match(/[?&]list=([A-Za-z0-9_-]+)/) || [])[1];
  if (!id) throw new Error("that doesn't look like a YouTube playlist link");
  const tracks = [];
  let title = "YouTube";
  for (let page = 1; page <= 10; page++) {
    const p = await inv(`/api/v1/playlists/${id}?page=${page}`);
    title = p.title || title;
    const vids = (p.videos || []).filter((v) => v.videoId && !tracks.some((t) => t.youtube === v.videoId));
    if (!vids.length) break;
    vids.forEach((v) => tracks.push({ title: v.title || "", artist: v.author || "", duration: v.lengthSeconds || 0, youtube: v.videoId }));
    if (tracks.length >= (p.videoCount || 0)) break;
  }
  return { title, source: "youtube", tracks };
}

// ------------------------------------------------------------------ the fake helper
// server = the okMUSIC server link (it can still read Spotify playlists, YouTube only blocks its downloads)
export async function fetchLike(path, { raw = false, server = "" } = {}) {
  const u = new URL(path, "http://x");
  const q = Object.fromEntries(u.searchParams);
  const dur = q.dur ? +q.dur : null;
  switch (u.pathname) {
    case "/search":
      return { results: await search(q.q || "", Math.min(10, +q.n || 6)) };
    case "/match":
    case "/resolve":
      return await bestMatch(q.q || "", dur);
    case "/list": {
      const link = q.url || "";
      if (/youtu/.test(link)) return await youtubeList(link);
      if (/spotify/.test(link)) {
        if (!server) throw new Error("Spotify links need you to connect Spotify in Settings (or the PC helper)");
        const r = await fetch(server + "/list?url=" + encodeURIComponent(link));
        const j = await r.json();
        if (!r.ok || j.error) throw new Error(j.error || "couldn't read that Spotify list");
        return j;
      }
      throw new Error("paste a Spotify or YouTube link");
    }
    case "/download": {
      let id = q.id, title = q.title || "";
      if (!id) {
        const m = await bestMatch(q.q || "", dur);
        id = m.id;
        title = title || m.title;
      }
      const d = await download(id);
      const res = new Response(d.blob, {
        headers: { "X-Video-Id": id, "X-Ext": d.ext, "X-Title": encodeURIComponent(title || d.title) },
      });
      if (!raw) throw new Error("download needs raw");
      return res;
    }
  }
  throw new Error("unknown");
}
