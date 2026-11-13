// okMUSIC library tools
// ---------------------------------------------------------------------------
//  * Add From Link  - paste direct links to audio files, they get saved in the library
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
        if (/quota/i.test((e && e.name) + " " + (e && e.message))) {
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
  row.innerHTML = `<button id="ltLinkBtn" class="bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border border-blue-400/30 font-bold py-3 rounded-lg text-[10px] tracking-wider uppercase transition"><i class="fa-solid fa-link mr-2"></i> Add From Link</button>`;
  if (importBtn) importBtn.insertAdjacentElement("afterend", row);
  else if (holder) holder.appendChild(row);
  $("ltLinkBtn").addEventListener("click", openLinkModal);
}

function init() {
  if (!window.player || !window.ui || !window.libraryMgr) {
    console.warn("library-tools: app not ready, tools not loaded");
    return;
  }
  buildUI();
  window.libraryTools = { openLinkModal, fetchAudio, saveSong, alreadyInLibrary };
}

init();
