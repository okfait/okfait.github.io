// okMUSIC v2.19.0: song names.
// Songs are saved as "Artist - Title". This splits them back up (the library shows the artist
// under the title) and gets the real name of a pasted YouTube link (used to say
// "from your link - YouTube video").

const YT_ID = /(?:youtu\.be\/|[?&]v=|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/;

function cleanChannel(c) {
  return String(c || "")
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/\s+official$/i, "")
    .trim();
}

// "Artist - Title" from a video's title + channel (if the title already has the artist, keep it)
function niceName(title, channel) {
  const t = String(title || "").trim();
  const ch = cleanChannel(channel);
  if (!ch || /\s[-–—]\s/.test(t)) return t;
  return `${ch} - ${t}`;
}

// old pasted-link songs got this name before v2.19.0
function isBroken(name) {
  return /^from your link\s*-\s*YouTube video$/i.test(String(name || "").trim());
}

function splitName(name) {
  const n = String(name || "").trim();
  if (isBroken(n)) return { artist: "", title: n, broken: true };
  const m = n.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: "", title: n };
}

function ytId(text) {
  const m = String(text || "").match(YT_ID);
  return m ? m[1] : null;
}

async function getJson(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// { title, channel, duration } of a YouTube video. YouTube's own oEmbed first (always there),
// then a free mirror for the length.
async function ytInfo(id) {
  const out = { title: "", channel: "", duration: 0 };
  try {
    const j = await getJson("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + id));
    out.title = j.title || "";
    out.channel = j.author_name || "";
  } catch (e) {}
  if (out.title) return out; // oEmbed answered (instant): don't wait on the slow mirror for the length
  try {
    let base = "";
    try {
      base = localStorage.getItem("okmusic_inv_good") || "";
    } catch (e) {}
    const j = await getJson((base || "https://yt.chocolatemoo53.com") + "/api/v1/videos/" + id + "?fields=title,author,lengthSeconds");
    out.title = out.title || j.title || "";
    out.channel = out.channel || j.author || "";
    out.duration = j.lengthSeconds || 0;
  } catch (e) {}
  return out;
}

window.songNames = { splitName, niceName, isBroken, ytId, ytInfo, cleanChannel };
