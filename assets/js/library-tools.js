// okMUSIC library tools
// ---------------------------------------------------------------------------
//  * Add From Link  - paste direct links to audio files, they get saved in the library
//  * Bulk adding    - drop songs or whole folders anywhere on the page, "Add Folder"
//                     button, progress, duplicate skipping, storage-full message
//  * Storage care   - asks the browser not to auto-delete your songs, shows usage
//  * Media keys     - headphone / keyboard / lock-screen play-pause-next-prev + now playing info
//  * Sleep timer    - in Settings: fade out and pause after X minutes or after this song
//  * Use My Files   - in the Spotify playlist importer: pick audio files you already have,
//                     they get matched to the playlist's songs by name
//
// This lives in its own file on purpose: app.js is huge, and this way these
// features can be changed or switched off without touching it.
// It needs window.player / window.ui / window.libraryMgr, which app.js creates
// (app.js is loaded first, see index.html).
// ---------------------------------------------------------------------------

const AUDIO_EXT = ["mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba", "webm"];
const MIME_BY_EXT = {
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
  m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", weba: "audio/webm", webm: "audio/webm",
};
const EXT_BY_MIME = {
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
  "audio/ogg": "ogg", "application/ogg": "ogg", "audio/opus": "opus", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
  "audio/aac": "aac", "audio/flac": "flac", "audio/x-flac": "flac", "audio/webm": "weba",
};
const MAX_BYTES = 250 * 1024 * 1024; // one file bigger than this is almost certainly a mistake
const STREAMING_SITES =
  /(^|\.)(youtube\.com|youtu\.be|spotify\.com|soundcloud\.com|music\.apple\.com|deezer\.com|tidal\.com|bandcamp\.com)$/i;

const $ = (id) => document.getElementById(id);
const toast = (msg) => window.ui && window.ui.showToast(msg);
const mb = (bytes) => (bytes / 1048576).toFixed(bytes > 10485760 ? 0 : 1);

function extOf(name) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

function nameFromUrl(u) {
  try {
    const last = decodeURIComponent(new URL(u).pathname.split("/").filter(Boolean).pop() || "");
    const base = last.replace(/\.[^/.]+$/, "").replace(/_+/g, " ").trim();
    return base || new URL(u).hostname;
  } catch (e) {
    return "Linked song";
  }
}

class LinkError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// Downloads one link and checks it really is an audio file.
// Returns { blob, ext, type }.  Throws LinkError with a plain-English message.
async function fetchAudio(url, onProgress) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    throw new LinkError("bad", "That doesn't look like a link.");
  }
  if (!/^https?:$/.test(u.protocol)) throw new LinkError("bad", "Only http/https links work.");
  if (STREAMING_SITES.test(u.hostname)) {
    throw new LinkError(
      "stream",
      "Streaming sites (YouTube, Spotify, SoundCloud...) don't hand out the audio file, so a link to them can't be added. Use a link straight to an audio file.",
    );
  }
  if (location.protocol === "https:" && u.protocol === "http:") {
    throw new LinkError("mixed", "That link is plain http://, which your browser blocks on this secure site. Try the https:// version.");
  }

  let res;
  try {
    res = await fetch(u.href, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
  } catch (e) {
    throw new LinkError(
      "blocked",
      "Couldn't load that link. Usually the site doesn't allow other sites to use its files, or the link is wrong or offline.",
    );
  }
  if (!res.ok) {
    throw new LinkError("http", `The site answered with error ${res.status}${res.statusText ? " (" + res.statusText + ")" : ""}.`);
  }

  const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = extOf(u.pathname);
  const looksAudio =
    type.startsWith("audio/") ||
    type === "application/ogg" ||
    (["", "application/octet-stream", "binary/octet-stream"].includes(type) && AUDIO_EXT.includes(ext));
  if (!looksAudio) {
    throw new LinkError(
      "notaudio",
      `That link is ${type ? "a " + type + " file" : "something unknown"}, not audio. It's probably a web page, you need the link to the song file itself (ends in .mp3, .wav, .ogg...).`,
    );
  }

  const total = Number(res.headers.get("content-length")) || 0;
  if (total > MAX_BYTES) throw new LinkError("big", `That file is ${mb(total)} MB, over the ${mb(MAX_BYTES)} MB limit.`);

  const chunks = [];
  let got = 0;
  try {
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (got > MAX_BYTES) {
          reader.cancel();
          throw new LinkError("big", `That file is over the ${mb(MAX_BYTES)} MB limit.`);
        }
        if (onProgress) onProgress(got, total);
      }
    } else {
      const b = await res.blob();
      chunks.push(b);
      got = b.size;
    }
  } catch (e) {
    if (e instanceof LinkError) throw e;
    throw new LinkError("cut", "The download got interrupted.");
  }
  if (got < 1000) throw new LinkError("tiny", "That file is too small to be a song.");

  const goodExt = AUDIO_EXT.includes(ext) ? ext : EXT_BY_MIME[type] || "mp3";
  const blobType = type.startsWith("audio/") ? type : MIME_BY_EXT[goodExt] || "audio/mpeg";
  return { blob: new Blob(chunks, { type: blobType }), ext: goodExt, type: blobType };
}

// Saves a blob in the library the same way a normal file upload does.
async function saveSong(blob, name, ext, type) {
  const safe = name.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Linked song";
  const file = new File([blob], `${safe}.${ext}`, { type });
  return window.player.db.add(file);
}

function alreadyInLibrary(name, size) {
  return (window.player.songs || []).some((s) => s.name === name && s.blob && s.blob.size === size);
}

// ------------------------------------------------------------- bulk adding
const isAudioFile = (f) => (f.type && f.type.startsWith("audio/")) || AUDIO_EXT.includes(extOf(f.name));
const isQuotaError = (e) => /quota/i.test((e && e.name) + " " + (e && e.message));

function showProgress(text) {
  let el = $("ltProgress");
  if (!el) {
    el = document.createElement("div");
    el.id = "ltProgress";
    el.style.cssText =
      "position:fixed; left:50%; bottom:28px; transform:translateX(-50%); z-index:10060; max-width:92vw;" +
      "padding:10px 16px; border-radius:14px; background:rgba(18,18,22,0.94); color:#fff;" +
      "border:1px solid rgba(255,255,255,0.15); font:700 11px/1.4 system-ui,sans-serif; letter-spacing:.04em;" +
      "box-shadow:0 10px 30px rgba(0,0,0,.5); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.display = "block";
}
function hideProgress() {
  const el = $("ltProgress");
  if (el) el.style.display = "none";
}

// Walks a dropped folder (browser "entry" objects) and collects every file in it.
// readEntries only hands back ~100 items per call, so it has to be called until it returns nothing.
async function walkEntry(entry, folder, out, depth = 0) {
  if (!entry || out.length >= 5000 || depth > 12) return;
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
    if (file) out.push({ file, folder });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej)).catch(() => []);
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, folder, out, depth + 1);
    }
  }
}

let importBusy = false;

// items: [{ file, folder }]  (folder = name of the library folder to put it in, or null)
async function importFiles(items) {
  if (importBusy) {
    toast("Still adding the last batch, one moment...");
    return;
  }
  const audio = items.filter((x) => isAudioFile(x.file));
  const sidecars = items.filter((x) => /\.json$/i.test(x.file.name)).map((x) => x.file);
  const ignored = items.length - audio.length - sidecars.length;
  if (!audio.length) {
    toast(items.length ? "No audio files in there" : "Nothing to add");
    return;
  }

  importBusy = true;
  let dup = 0;
  let storageFull = false;
  const failed = [];
  const addedIds = []; // [{ id, folder }]
  const seen = new Set(); // catches the same song twice inside one drop
  try {
    for (let i = 0; i < audio.length; i++) {
      const { file, folder } = audio[i];
      showProgress(`Adding ${i + 1}/${audio.length}  ·  ${file.name}`);
      const base = file.name.replace(/\.[^/.]+$/, "");
      const key = base + "|" + file.size;
      if (seen.has(key) || alreadyInLibrary(base, file.size)) {
        dup++;
        continue;
      }
      seen.add(key);

      let data = null; // optional saved settings file that sits next to a song (same rule as the old uploader)
      const side = sidecars.find((jf) => jf.name.includes(base));
      if (side) {
        try {
          data = JSON.parse(await side.text());
        } catch (e) {
          console.warn("Couldn't read settings file", side.name, e);
        }
      }
      try {
        const id = await window.player.db.add(file, data);
        addedIds.push({ id, folder });
      } catch (e) {
        if (isQuotaError(e)) {
          storageFull = true;
          break;
        }
        console.warn("Couldn't add", file.name, e);
        failed.push(file.name);
      }
      if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0)); // let the page breathe on big batches
    }
  } finally {
    hideProgress();
    importBusy = false;
  }

  if (addedIds.length) {
    // songs that came from a folder go into a library folder with the same name
    const byFolder = new Map();
    for (const a of addedIds) {
      if (!a.folder) continue;
      if (!byFolder.has(a.folder)) byFolder.set(a.folder, []);
      byFolder.get(a.folder).push({ type: "song", id: a.id });
    }
    for (const [name, list] of byFolder) {
      window.libraryMgr.structure.unshift({
        type: "folder",
        id: crypto.randomUUID(),
        name,
        items: list,
        isOpen: true,
        color: "#60a5fa",
      });
    }
    window.libraryMgr.save();
    await window.player.loadLib();
    if (window.ltStorage) window.ltStorage.afterAdd();
  }

  const parts = [];
  if (addedIds.length) parts.push(`Added ${addedIds.length} song${addedIds.length > 1 ? "s" : ""}`);
  if (dup) parts.push(`${dup} already in your library`);
  if (failed.length) parts.push(`${failed.length} failed`);
  if (ignored && !addedIds.length && !dup) parts.push(`${ignored} not audio`);
  toast(parts.join(" · ") || "Nothing was added");
  if (storageFull) {
    alert(
      `Your browser's storage for this site is full, so adding stopped` +
        (addedIds.length ? ` after ${addedIds.length} song${addedIds.length > 1 ? "s" : ""}` : "") +
        `.\n\nFree up space by deleting songs you don't need (Collection panel), or by clearing other site data in your browser settings.`,
    );
  }
}

// Turns what the old uploader got (a file input, or a drag "dataTransfer") into [{file, folder}]
function itemsFromInput(input) {
  let files = [];
  if (input && input.files && input.files.length) files = Array.from(input.files);
  else if (input && input.items) files = Array.from(input.items).filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean);
  return files.map((file) => {
    const rel = file.webkitRelativePath || "";
    return { file, folder: rel.includes("/") ? rel.split("/")[0] : null };
  });
}

const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files"));

function setOverlay(on) {
  const o = $("ltDropOverlay");
  if (o) o.style.display = on ? "flex" : "none";
}

// ------------------------------------------------------------ storage care
let persistAsked = false;

// Asks the browser to keep this site's data (your songs) even when disk space gets low.
// Browsers may say no; that's fine, nothing breaks.
async function requestPersist() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return false;
    if (await navigator.storage.persisted()) return true;
    if (persistAsked) return false;
    persistAsked = true;
    return await navigator.storage.persist();
  } catch (e) {
    return false;
  }
}

async function refreshStorage() {
  const el = $("ltStorageLine");
  if (!el || !navigator.storage || !navigator.storage.estimate) return;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const size = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : Math.round(b / 1048576) + " MB");
    el.textContent = `Storage used: ${size(usage)}` + (quota ? ` of ~${size(quota)}` : "") + (persisted ? " · protected" : "");
    el.title = persisted
      ? "Your browser promised not to clear your songs by itself."
      : "If your computer gets very low on disk space the browser may clear site data. Adding songs asks it to protect them.";
  } catch (e) {
    /* estimate not available - the line just stays as it was */
  }
}

window.ltStorage = {
  refresh: refreshStorage,
  afterAdd: async () => {
    await requestPersist();
    refreshStorage();
  },
};

// ------------------------------------------------------------- media keys
function setupMediaSession() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const audio = window.audioSys.audio;
  const on = (name, fn) => {
    try {
      ms.setActionHandler(name, fn);
    } catch (e) {
      /* this browser doesn't know that button */
    }
  };
  const toggleIf = (wantPlaying) => {
    if (audio.paused === wantPlaying) window.player.togglePlay();
  };
  on("play", () => toggleIf(true));
  on("pause", () => toggleIf(false));
  on("stop", () => toggleIf(false));
  on("nexttrack", () => window.player.next());
  on("previoustrack", () => window.player.prev());
  on("seekto", (d) => {
    if (d && typeof d.seekTime === "number") audio.currentTime = d.seekTime;
  });
  on("seekbackward", (d) => {
    audio.currentTime = Math.max(0, audio.currentTime - ((d && d.seekOffset) || 10));
  });
  on("seekforward", (d) => {
    audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + ((d && d.seekOffset) || 10));
  });

  const setInfo = () => {
    const t = window.player.currentTrack;
    if (!t || typeof MediaMetadata === "undefined") return;
    const raw = String(t.name || "okMUSIC");
    const i = raw.indexOf(" - ");
    const md = { title: i > 0 ? raw.slice(i + 3) : raw, artist: i > 0 ? raw.slice(0, i) : "okMUSIC", album: "okMUSIC" };
    if (typeof t.art === "string" && /^(data:|https?:|blob:)/.test(t.art)) md.artwork = [{ src: t.art }];
    try {
      ms.metadata = new MediaMetadata(md);
    } catch (e) {
      /* bad artwork etc. - keep the old info */
    }
  };
  const setPos = () => {
    try {
      if (isFinite(audio.duration) && audio.duration > 0) {
        ms.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate || 1,
          position: Math.min(audio.currentTime, audio.duration),
        });
      }
    } catch (e) {
      /* odd speed/position values - skip this update */
    }
  };
  audio.addEventListener("loadedmetadata", setInfo);
  audio.addEventListener("play", () => {
    setInfo();
    ms.playbackState = "playing";
  });
  audio.addEventListener("pause", () => {
    ms.playbackState = "paused";
  });
  ["loadedmetadata", "play", "pause", "seeked", "ratechange"].forEach((ev) => audio.addEventListener(ev, setPos));
}

// ------------------------------------------------------------- sleep timer
const sleep = { endAt: 0, timer: 0, tick: 0, fade: 0, afterSong: false, gainBefore: null };
const mmss = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const sleepSay = (text) => {
  const el = $("ltSleepStatus");
  if (el) el.textContent = text;
};
const gainParam = () => {
  const a = window.audioSys;
  return a && a.gain && a.gain.gain ? a.gain.gain : null;
};

// Stops every timer. restoreVolume=true puts the volume back if a fade-out was running.
function sleepCancel(restoreVolume = true) {
  clearTimeout(sleep.timer);
  clearInterval(sleep.tick);
  clearInterval(sleep.fade);
  sleep.timer = sleep.tick = sleep.fade = 0;
  sleep.afterSong = false;
  sleep.endAt = 0;
  const g = gainParam();
  if (restoreVolume && g && sleep.gainBefore != null) g.value = sleep.gainBefore;
  sleep.gainBefore = null;
  sleepSay("Off");
  const sel = $("ltSleepSelect");
  if (sel && sel.value !== "0") sel.value = "0";
}

// Fades the volume to nothing, pauses, then puts the volume back for next time.
function sleepFadeAndPause(fadeMs) {
  const audio = window.audioSys.audio;
  const g = gainParam();
  const done = () => {
    const before = sleep.gainBefore;
    clearInterval(sleep.fade);
    sleep.fade = 0;
    audio.pause();
    window.ui.updatePlayBtn(false);
    // put the volume back a moment later so a bit of leftover sound can't blip out
    setTimeout(() => {
      if (g && before != null) g.value = before;
    }, 400);
    sleep.gainBefore = null;
    sleepCancel(false);
    toast("Sleep timer: paused. Good night!");
  };
  if (audio.paused) {
    sleepCancel(false);
    return;
  }
  if (!g || fadeMs <= 0) {
    done();
    return;
  }
  sleep.gainBefore = g.value;
  const started = performance.now();
  sleep.fade = setInterval(() => {
    const t = (performance.now() - started) / fadeMs;
    if (t >= 1) done();
    else g.value = sleep.gainBefore * (1 - t);
  }, 200);
}

// value: "0" (off), "song" (after this song) or minutes
function startSleep(value, fadeSeconds = 10) {
  sleepCancel(true);
  if (value === "song") {
    sleep.afterSong = true;
    sleepSay("After this song");
    toast("Will pause after this song");
    const sel = $("ltSleepSelect");
    if (sel) sel.value = "song";
    return;
  }
  const minutes = Number(value);
  if (!(minutes > 0)) return;
  const total = minutes * 60000;
  const fadeMs = Math.min(fadeSeconds * 1000, total / 2);
  sleep.endAt = Date.now() + total;
  sleep.timer = setTimeout(() => sleepFadeAndPause(fadeMs), total - fadeMs);
  sleep.tick = setInterval(() => sleepSay("Pauses in " + mmss(Math.max(0, sleep.endAt - Date.now()))), 1000);
  sleepSay("Pauses in " + mmss(total));
  toast(`Sleep timer set: ${minutes < 1 ? minutes * 60 + " sec" : minutes + " min"}`);
}

function setupSleepTimer() {
  // "After this song": the app calls player.onEnd() when a song finishes, so we step in there
  const origOnEnd = window.player.onEnd.bind(window.player);
  window.player.onEnd = (...args) => {
    if (sleep.afterSong) {
      sleepCancel(true);
      window.audioSys.audio.pause();
      window.ui.updatePlayBtn(false);
      toast("Sleep timer: paused. Good night!");
      return;
    }
    return origOnEnd(...args);
  };

  // Row in the settings panel, under Lite Mode
  const liteRow = $("liteToggle") ? $("liteToggle").closest("label") : null;
  if (!liteRow) return;
  liteRow.insertAdjacentHTML(
    "afterend",
    `<div class="flex justify-between items-center bg-white/5 border border-white/10 p-4 h-[72px] mx-2 mt-4 rounded-xl">
        <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white/70"><i class="fa-solid fa-moon"></i></div>
            <div class="flex flex-col">
                <span class="text-xs font-black text-white/90 tracking-widest uppercase">SLEEP TIMER</span>
                <span id="ltSleepStatus" class="text-[9px] font-bold text-white/40">Off</span>
            </div>
        </div>
        <select id="ltSleepSelect" style="color-scheme:dark" class="bg-black/60 border border-white/10 rounded-lg text-[11px] font-bold text-white p-2 outline-none cursor-pointer">
            <option value="0">Off</option><option value="song">After this song</option>
            <option value="15">15 min</option><option value="30">30 min</option><option value="45">45 min</option>
            <option value="60">1 hour</option><option value="90">1.5 hours</option>
        </select>
    </div>`,
  );
  $("ltSleepSelect").addEventListener("change", (e) => {
    if (e.target.value === "0") sleepCancel(true);
    else startSleep(e.target.value);
  });
}

// ------------------------------------------------- playlist: use my files
// Words that don't help tell songs apart ("Official Video", "feat.", years...).
const NOISE = new Set([
  "official", "video", "audio", "lyrics", "lyric", "music", "hd", "hq", "4k", "remaster", "remastered",
  "version", "visualizer", "visualiser", "explicit", "clean", "feat", "ft", "featuring", "with", "mono",
  "stereo", "edit", "radio", "deluxe", "bonus", "original", "soundtrack", "from", "and", "the",
]);
// ...but these inside brackets DO matter: "Song (Remix)" is not "Song".
const MODIFIERS = new Set(["remix", "live", "acoustic", "instrumental", "slowed", "sped", "cover"]);

function nameTokens(text) {
  return String(text)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // é -> e
    .toLowerCase()
    .replace(/['’`]/g, "") // don't -> dont
    .replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
const isOptionalWord = (w) => NOISE.has(w) || /^(19|20)\d\d$/.test(w);

// "Song (feat. X)" -> { outside: "Song ", inside: "feat. X" }
function splitBrackets(text) {
  let inside = "";
  const outside = String(text).replace(/[([{]([^)\]}]*)[)\]}]/g, (_, g) => {
    inside += " " + g;
    return " ";
  });
  return { outside, inside };
}

// the words of a playlist song that a file name must contain
function requiredWords(trackName) {
  const { outside, inside } = splitBrackets(trackName);
  const req = [...new Set(nameTokens(outside).filter((w) => !isOptionalWord(w)))];
  for (const w of nameTokens(inside)) if (MODIFIERS.has(w) && !req.includes(w)) req.push(w);
  return req;
}
const fileWords = (fileName) => new Set(nameTokens(fileName.replace(/\.[^/.]+$/, "")).filter((w) => !isOptionalWord(w)));

// 0 = no match, otherwise higher = better
function matchScore(req, words) {
  if (!req.length || !words.size) return 0;
  const hit = req.filter((w) => words.has(w)).length;
  const cover = hit / req.length; // how much of the song's name is in the file name
  if (cover < 0.75 || (req.length > 1 && hit < 2)) return 0;
  const unexplained = [...words].filter((w) => !req.includes(w)).length / words.size; // leftover junk in the file name
  return cover - 0.25 * unexplained;
}

// Pairs each playlist song with the best-matching file (every file used at most once).
// Returns { pairs: [{track, file}] in playlist order, missing: [track], unused: [file] }
function matchFilesToTracks(tracks, files) {
  const reqs = tracks.map((t) => requiredWords(t.name));
  const words = files.map((f) => fileWords(f.name));
  const cand = [];
  for (let ti = 0; ti < tracks.length; ti++) {
    for (let fi = 0; fi < files.length; fi++) {
      const s = matchScore(reqs[ti], words[fi]);
      if (s > 0) cand.push({ ti, fi, s });
    }
  }
  cand.sort((a, b) => b.s - a.s);
  const tUsed = new Set();
  const fUsed = new Set();
  const picked = [];
  for (const c of cand) {
    if (tUsed.has(c.ti) || fUsed.has(c.fi)) continue;
    tUsed.add(c.ti);
    fUsed.add(c.fi);
    picked.push(c);
  }
  picked.sort((a, b) => a.ti - b.ti);
  return {
    pairs: picked.map((p) => ({ track: tracks[p.ti], file: files[p.fi] })),
    missing: tracks.filter((_, i) => !tUsed.has(i)),
    unused: files.filter((_, i) => !fUsed.has(i)),
  };
}

async function copyText(text, promptLabel) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied!");
  } catch (e) {
    window.prompt(promptLabel, text.replace(/\n/g, " | ")); // clipboard blocked: show it to copy by hand
  }
}

async function useMyFiles(fileList) {
  const tracks = window.ui._pendingPlaylistTracks || [];
  const playlistName = window.ui._pendingPlaylistName || "Imported Playlist";
  const files = Array.from(fileList).filter(isAudioFile);
  if (!tracks.length) {
    toast("Press SCAN LINK first, so I know the song list");
    return;
  }
  if (!files.length) {
    toast("No audio files picked");
    return;
  }
  const { pairs, missing, unused } = matchFilesToTracks(tracks, files);
  if (!pairs.length) {
    alert(
      `None of those ${files.length} files matched a song in "${playlistName}".\n\n` +
        `The file names need to contain the artist and the song name, like "Artist - Song.mp3".`,
    );
    return;
  }
  window.ui.closePlaylistImporter();
  // files go in playlist order, so the library folder ends up in playlist order too
  await importFiles(pairs.map((p) => ({ file: p.file, folder: playlistName })));

  if (!missing.length) {
    toast(`All ${tracks.length} songs matched!`);
    return;
  }
  const shown = missing.slice(0, 8).map((t) => "• " + t.name);
  if (missing.length > 8) shown.push(`...and ${missing.length - 8} more`);
  const skipped = unused.length ? `\n(${unused.length} of your files didn't match any song and were skipped.)` : "";
  if (
    confirm(
      `Matched ${pairs.length} of ${tracks.length} songs.\n\nStill missing (${missing.length}):\n${shown.join("\n")}${skipped}\n\n` +
        `Copy the list of missing songs?`,
    )
  ) {
    await copyText(missing.map((t) => t.name).join("\n"), "Copy the missing songs (Ctrl+C):");
  }
}

// ---------------------------------------------------------------- modal bits
function openModal(id) {
  const m = $(id);
  if (!m) return;
  m.style.opacity = "1";
  m.style.pointerEvents = "auto";
}
function closeModal(id) {
  const m = $(id);
  if (!m) return;
  m.style.opacity = "0";
  m.style.pointerEvents = "none";
}

function setStatus(text, kind) {
  const el = $("ltLinkStatus");
  if (!el) return;
  if (!text) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  el.textContent = text;
  el.style.whiteSpace = "pre-line";
  const bad = kind === "bad";
  el.style.color = bad ? "#fca5a5" : "#93c5fd";
  el.style.background = bad ? "rgba(239,68,68,0.10)" : "rgba(96,165,250,0.10)";
  el.style.borderColor = bad ? "rgba(239,68,68,0.25)" : "rgba(96,165,250,0.25)";
}

let linkBusy = false;

async function addFromLinks() {
  if (linkBusy) return;
  const input = $("ltLinkInput");
  const urls = [...new Set(input.value.split(/\s+/).map((s) => s.trim()).filter(Boolean))];
  if (!urls.length) {
    setStatus("Paste at least one link first.", "bad");
    return;
  }

  linkBusy = true;
  const btn = $("ltLinkGo");
  const label = btn.textContent;
  btn.textContent = "ADDING...";
  btn.style.pointerEvents = "none";

  let added = 0;
  let skipped = 0;
  const failed = []; // { url, msg }
  try {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const prefix = urls.length > 1 ? `Song ${i + 1}/${urls.length}: ` : "";
      setStatus(`${prefix}downloading...`);
      try {
        const { blob, ext, type } = await fetchAudio(url, (got, total) =>
          setStatus(`${prefix}downloading ${total ? Math.round((got / total) * 100) + "%" : mb(got) + " MB"}`),
        );
        const name = nameFromUrl(url);
        if (alreadyInLibrary(name, blob.size)) {
          skipped++;
          continue;
        }
        await saveSong(blob, name, ext, type);
        added++;
      } catch (e) {
        if (isQuotaError(e)) {
          failed.push({ url, msg: "Your browser's storage for this site is full." });
          break;
        }
        failed.push({ url, msg: e instanceof LinkError ? e.message : "Something went wrong: " + (e && e.message) });
      }
    }
  } finally {
    if (added) {
      await window.player.loadLib();
      if (window.ltStorage) window.ltStorage.refresh();
    }
    linkBusy = false;
    btn.textContent = label;
    btn.style.pointerEvents = "auto";
  }

  const parts = [];
  if (added) parts.push(`Added ${added} song${added > 1 ? "s" : ""}`);
  if (skipped) parts.push(`${skipped} already in your library`);
  if (!failed.length) {
    toast(parts.join(" · ") || "Nothing to add");
    input.value = "";
    setStatus("");
    closeModal("ltLinkModal");
    return;
  }
  // keep only the links that failed so they can be fixed and retried
  input.value = failed.map((f) => f.url).join("\n");
  const lines = failed.slice(0, 3).map((f) => `• ${nameFromUrl(f.url)}: ${f.msg}`);
  if (failed.length > 3) lines.push(`...and ${failed.length - 3} more`);
  setStatus([parts.join(" · "), ...lines].filter(Boolean).join("\n"), "bad");
  if (added) toast(parts.join(" · "));
}

function openLinkModal() {
  setStatus("");
  openModal("ltLinkModal");
  const input = $("ltLinkInput");
  if (input) input.focus();
}

// ------------------------------------------------------------------ build UI
function buildUI() {
  if ($("ltLinkModal")) return; // already built

  document.body.insertAdjacentHTML(
    "beforeend",
    `
    <div class="glass-modal" id="ltLinkModal" style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); z-index:10020; padding:24px; border-radius:24px; width:min(360px, 92vw); opacity:0; pointer-events:none; transition:0.3s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 40px rgba(96, 165, 250, 0.1);">
        <h3 class="font-black tracking-tighter mb-2 text-2xl text-white"><i class="fa-solid fa-link text-blue-400 mr-2"></i> Add From Link</h3>
        <p class="text-[10px] text-white/40 font-bold uppercase tracking-widest mb-4 leading-relaxed">Paste links to audio files (.mp3, .wav, .ogg...), one per line. They get saved in your library, so every effect works on them.</p>
        <textarea id="ltLinkInput" rows="4" spellcheck="false" placeholder="https://example.com/song.mp3" class="w-full bg-white/5 border border-white/10 rounded-xl p-4 mb-3 text-xs font-bold text-white outline-none focus:border-blue-400 transition shadow-inner resize-none"></textarea>
        <p class="text-[9px] text-white/30 font-bold leading-relaxed mb-3">Works with files on sites that allow it (GitHub raw links, your own server, free-music sites). YouTube / Spotify / SoundCloud pages can't be added this way.</p>
        <div id="ltLinkStatus" class="hidden text-xs font-bold p-3 mb-2 rounded-xl border leading-relaxed"></div>
        <div class="flex justify-end gap-2 mt-4">
            <button id="ltLinkCancel" class="text-xs font-bold px-4 py-3 rounded-xl hover:bg-white/5 transition uppercase tracking-wider">Close</button>
            <button id="ltLinkGo" class="text-xs font-bold bg-blue-400 text-black px-6 py-3 rounded-xl shadow-lg hover:scale-105 transition uppercase tracking-widest">Add</button>
        </div>
    </div>`,
  );
  $("ltLinkGo").addEventListener("click", addFromLinks);
  $("ltLinkCancel").addEventListener("click", () => closeModal("ltLinkModal"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal("ltLinkModal");
  });

  // Button in the library panel, right under "Import URL"
  const importBtn = document.querySelector('button[onclick="window.ui.openPlaylistImporter()"]');
  const holder = importBtn ? importBtn.parentElement : document.querySelector("#libraryPanel .panel-content");
  const row = document.createElement("div");
  row.id = "ltToolRow";
  row.className = "grid gap-2 mt-2";
  row.style.gridTemplateColumns = "repeat(auto-fit, minmax(90px, 1fr))";
  row.innerHTML = `
    <button id="ltFolderBtn" class="bg-white/5 hover:bg-white/10 text-white/80 border border-white/15 font-bold py-3 rounded-lg text-[10px] tracking-wider uppercase transition"><i class="fa-solid fa-folder-open mr-2"></i> Add Folder</button>
    <button id="ltLinkBtn" class="bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border border-blue-400/30 font-bold py-3 rounded-lg text-[10px] tracking-wider uppercase transition"><i class="fa-solid fa-link mr-2"></i> Add From Link</button>
    <input type="file" id="ltFolderInput" webkitdirectory multiple class="hidden">`;
  if (importBtn) importBtn.insertAdjacentElement("afterend", row);
  else if (holder) holder.appendChild(row);
  $("ltLinkBtn").addEventListener("click", openLinkModal);
  $("ltFolderBtn").addEventListener("click", () => $("ltFolderInput").click());
  $("ltFolderInput").addEventListener("change", async (e) => {
    const items = itemsFromInput(e.target); // read the list BEFORE clearing the input
    e.target.value = "";
    await importFiles(items);
  });

  // "Use my files" under the buttons of the Spotify playlist importer
  const scanBtn = $("btnScanPlaylist");
  if (scanBtn && scanBtn.parentElement && !$("ltMatchBtn")) {
    const matchRow = document.createElement("div");
    matchRow.className = "mt-3";
    matchRow.innerHTML = `
      <button id="ltMatchBtn" class="w-full bg-white/5 hover:bg-white/10 text-white/70 border border-white/15 font-bold py-3 rounded-xl text-[10px] tracking-wider uppercase transition"><i class="fa-solid fa-folder-open mr-2"></i> Already have the songs? Use my files</button>
      <input type="file" id="ltMatchInput" multiple accept="audio/*,.mp3,.wav,.ogg,.oga,.opus,.m4a,.aac,.flac,.weba,.webm" class="hidden">
      <p class="text-[9px] text-white/30 font-bold leading-relaxed mt-2 text-center">Press SCAN LINK first, then pick your audio files. They get matched to the playlist by name.</p>`;
    scanBtn.parentElement.insertAdjacentElement("afterend", matchRow);
    $("ltMatchBtn").addEventListener("click", () => {
      if (!(window.ui._pendingPlaylistTracks || []).length) {
        toast("Press SCAN LINK first, so I know the song list");
        return;
      }
      $("ltMatchInput").click();
    });
    $("ltMatchInput").addEventListener("change", async (e) => {
      const picked = Array.from(e.target.files); // read the list BEFORE clearing the input
      e.target.value = "";
      await useMyFiles(picked);
    });
  }

  // "Drop here" screen that appears while you drag files over the page
  const overlay = document.createElement("div");
  overlay.id = "ltDropOverlay";
  overlay.style.cssText =
    "position:fixed; inset:0; z-index:10050; display:none; align-items:center; justify-content:center; pointer-events:none; background:rgba(8,8,12,0.72);";
  overlay.innerHTML = `<div style="border:2px dashed rgba(96,165,250,0.8); border-radius:28px; padding:48px 56px; text-align:center; color:#fff; font:800 15px/1.5 system-ui,sans-serif; letter-spacing:.08em; max-width:84vw;">
      <div style="font-size:38px; margin-bottom:10px;"><i class="fa-solid fa-cloud-arrow-up" style="color:#60a5fa"></i></div>
      DROP SONGS OR FOLDERS<br><span style="font-weight:600; font-size:12px; opacity:.6; letter-spacing:.04em;">to add them to your library</span></div>`;
  document.body.appendChild(overlay);
}

// Everything that listens to the whole page. Capture phase on purpose: it runs
// before the library's own drop spots, so a file drop is handled exactly once.
function wireDropAnywhere() {
  window.addEventListener(
    "dragover",
    (e) => {
      if (!hasFiles(e)) return; // moving songs around inside the library is not touched
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setOverlay(true);
    },
    true,
  );
  window.addEventListener(
    "dragleave",
    (e) => {
      if (hasFiles(e) && !e.relatedTarget) setOverlay(false); // left the window
    },
    true,
  );
  window.addEventListener(
    "drop",
    async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setOverlay(false);
      // The browser only lets us read the dropped items during this event, so grab them now.
      const entries = [];
      const loose = [];
      for (const it of Array.from(e.dataTransfer.items || [])) {
        if (it.kind !== "file") continue;
        const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
        if (entry) entries.push(entry);
        else {
          const f = it.getAsFile();
          if (f) loose.push({ file: f, folder: null });
        }
      }
      if (!entries.length && !loose.length) loose.push(...itemsFromInput(e.dataTransfer));
      const out = [...loose];
      for (const entry of entries) await walkEntry(entry, entry.isDirectory ? entry.name : null, out);
      await importFiles(out);
    },
    true,
  );
  window.addEventListener("dragend", () => setOverlay(false), true);
}

function init() {
  if (!window.player || !window.ui || !window.libraryMgr) {
    console.warn("library-tools: app not ready, tools not loaded");
    return;
  }
  buildUI();
  wireDropAnywhere();

  // The old "+" button (and anything else that used the old uploader) now gets
  // the same progress, duplicate skipping and storage-full message.
  window.player.handleUpload = async (input) => {
    const items = itemsFromInput(input);
    if (input && input.tagName === "INPUT") input.value = "";
    await importFiles(items);
  };

  // Each extra is wrapped on its own, so if one breaks the others (and the player) keep working.
  const safely = (label, fn) => {
    try {
      fn();
    } catch (e) {
      console.warn("library-tools:", label, "failed to start", e);
    }
  };
  safely("media keys", setupMediaSession);
  safely("sleep timer", setupSleepTimer);
  safely("storage line", () => {
    // small line above "Factory Reset" in the library panel
    const reset = document.querySelector('button[onclick="window.player.db.clearAll()"]');
    if (reset && reset.parentElement && !$("ltStorageLine")) {
      const line = document.createElement("div");
      line.id = "ltStorageLine";
      line.className = "text-center text-[9px] font-bold text-white/30 tracking-wider uppercase pb-2";
      reset.parentElement.insertAdjacentElement("beforebegin", line);
    }
    refreshStorage();
    window.addEventListener("focus", refreshStorage);
    const origToggle = window.ui.toggleLibrary && window.ui.toggleLibrary.bind(window.ui);
    if (origToggle) {
      window.ui.toggleLibrary = (...args) => {
        const r = origToggle(...args);
        refreshStorage();
        return r;
      };
    }
  });

  window.libraryTools = {
    openLinkModal, fetchAudio, saveSong, alreadyInLibrary, importFiles, walkEntry,
    startSleep, sleepCancel, requestPersist, refreshStorage, matchFilesToTracks, useMyFiles,
  };
}

init();
