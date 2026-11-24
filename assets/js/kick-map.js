// Kick map: when a song starts, scan it once in the background (kick-scan.js) and save the list
// of kick times with the song. After that, V2's punch / zoom / shake and the bass ripple fire on
// those exact moments instead of guessing from the live sound.
//   window.kickMap.current() -> { id, t: [...seconds], s: [...strength] } for the playing song, or null
// While a song is still being scanned (about a second), V2 falls back to the old live detector.

const VER = 3; // bump when the scanner changes = every song gets re-scanned once
const mem = new Map(); // song id -> map
const failed = new Set();
let worker = null;
let busyId = null;
let waiters = {};

function getWorker() {
  if (worker) return worker;
  worker = new Worker(`assets/js/kick-scan.js?v=2.29.0&k=${VER}`);
  worker.onmessage = (e) => {
    const { id, t, s, err } = e.data;
    const done = waiters[id];
    delete waiters[id];
    if (done) done(err ? null : { t, s });
  };
  worker.onerror = () => {
    for (const id in waiters) waiters[id](null);
    waiters = {};
  };
  return worker;
}

// decode at a low sample rate (we only look at the bass, and it's way less work + memory)
async function decode(ab) {
  const C = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!C) return null;
  for (const rate of [8000, 22050, 44100]) {
    try {
      const c = new C(1, 1, rate);
      const b = await new Promise((res, rej) => {
        const p = c.decodeAudioData(ab.slice(0), res, rej);
        if (p && p.then) p.then(res, rej);
      });
      const x = new Float32Array(b.length);
      const n = b.numberOfChannels;
      for (let ch = 0; ch < n; ch++) {
        const d = b.getChannelData(ch);
        for (let i = 0; i < x.length; i++) x[i] += d[i] / n;
      }
      return { x, sr: b.sampleRate };
    } catch (e) {
      /* this browser can't do this rate: try the next one */
    }
  }
  return null;
}

// v2.27.0 silence trim: where the sound really starts / ends (dead-silent intro + outro get skipped).
// "silent" = every 10 ms slice peaks under ~-49 dB, so even a quiet fade-in counts as sound.
const TRIM_V = 1, QUIET = 0.0035;
function trimOf(x, sr) {
  const win = Math.max(1, Math.round(sr * 0.01));
  const n = Math.floor(x.length / win);
  const loud = (w) => {
    for (let i = w * win, e = i + win; i < e; i++) if (x[i] > QUIET || x[i] < -QUIET) return true;
    return false;
  };
  let a = 0;
  while (a < n && !loud(a)) a++;
  if (a >= n) return { v: TRIM_V, a: 0, b: 0, d: 0 }; // all silent: don't touch it
  let b = n - 1;
  while (b > a && !loud(b)) b--;
  const d = x.length / sr;
  return { v: TRIM_V, a: Math.max(0, (a * win) / sr - 0.03), b: Math.min(d, ((b + 1) * win) / sr + 0.1), d };
}
const trimFailed = new Set();
// songs scanned before v2.27.0 have a kick map but no trim: decode once more just for the trim
async function scanTrim(song) {
  const id = song.id;
  if (busyId) return;
  busyId = id;
  try {
    const ab = song.blob ? await song.blob.arrayBuffer() : song.url ? await (await fetch(song.url)).arrayBuffer() : null;
    if (!ab) throw new Error("no audio");
    const pcm = await decode(ab);
    if (!pcm) throw new Error("can't decode");
    song.trim = trimOf(pcm.x, pcm.sr);
    if (song.blob && window.player && window.player.db) window.player.db.update(id, { trim: song.trim }).catch(() => {});
  } catch (e) {
    trimFailed.add(id);
  } finally {
    busyId = null;
  }
}

async function scan(song) {
  const id = song.id;
  if (busyId) return;
  busyId = id;
  try {
    let ab;
    if (song.blob) ab = await song.blob.arrayBuffer();
    else if (song.url) ab = await (await fetch(song.url)).arrayBuffer();
    else throw new Error("no audio");
    const pcm = await decode(ab);
    ab = null;
    if (!pcm) throw new Error("can't decode");
    song.trim = trimOf(pcm.x, pcm.sr); // before the samples go to the worker
    const res = await new Promise((resolve) => {
      waiters[id] = resolve;
      getWorker().postMessage({ id, x: pcm.x, sr: pcm.sr }, [pcm.x.buffer]);
    });
    if (!res) throw new Error("scan failed");
    const map = { v: VER, t: res.t, s: res.s };
    mem.set(id, { id, t: map.t, s: map.s });
    song.kickMap = map;
    // saved with the song, so it's only ever scanned once
    if (song.blob && window.player && window.player.db) window.player.db.update(id, { kickMap: map, trim: song.trim }).catch(() => {});
  } catch (e) {
    failed.add(id);
  } finally {
    busyId = null;
  }
}

function check() {
  if (document.body.classList.contains("remote-mode")) return; // the PC sends its kicks to the phone
  const song = window.player && window.player.currentTrack;
  if (!song || !song.id || mem.has(song.id) || failed.has(song.id) || busyId) return;
  const saved = song.kickMap;
  if (saved && saved.v === VER && saved.t) {
    mem.set(song.id, { id: song.id, t: saved.t, s: saved.s });
    if (!(song.trim && song.trim.v === TRIM_V) && !trimFailed.has(song.id)) scanTrim(song);
    return;
  }
  scan(song);
}
setInterval(check, 500);
// the playing song also needs its trim when the kick map was already in memory
setInterval(() => {
  const song = window.player && window.player.currentTrack;
  if (!song || !song.id || busyId || trimFailed.has(song.id) || (song.trim && song.trim.v === TRIM_V)) return;
  if (mem.has(song.id) && !document.body.classList.contains("remote-mode")) scanTrim(song);
}, 700);

// skip the dead-silent start: once per song load, jump to where the sound starts
// (if you're still before it - a restored position or a seek is left alone)
let trimmedSrc = null;
function applyStart() {
  const as = window.audioSys;
  const a = as && as.audio;
  const song = window.player && window.player.currentTrack;
  if (!a || !song || !song.trim || song.trim.v !== TRIM_V || !a.src || trimmedSrc === a.src) return;
  if (!(a.duration > 0)) return;
  if (document.body.classList.contains("remote-mode") || (window.partyMode && window.partyMode.active && !window.partyMode.isHost)) return;
  trimmedSrc = a.src;
  const t = song.trim;
  if (t.a >= 0.3 && a.currentTime < t.a - 0.05) a.currentTime = t.a * (t.d ? a.duration / t.d : 1);
}
setInterval(applyStart, 80);
// where the sound really ends (Auto DJ fades out from there, and the song ends there)
function songEnd() {
  const a = window.audioSys && window.audioSys.audio;
  const song = window.player && window.player.currentTrack;
  if (!a || !(a.duration > 0)) return 0;
  const t = song && song.trim;
  if (!t || t.v !== TRIM_V || !t.d || t.d - t.b < 0.5) return a.duration;
  return Math.min(a.duration, t.b * (a.duration / t.d));
}

window.kickMap = {
  current() {
    const song = window.player && window.player.currentTrack;
    return (song && mem.get(song.id)) || null;
  },
  get busy() {
    return busyId;
  },
  _mem: mem,
  songEnd,
  trimOf,
  // v2.28.0: lyrics auto-sync needs the song's sound (8 kHz mono)
  async decode(song) {
    const ab = song.blob ? await song.blob.arrayBuffer() : song.url ? await (await fetch(song.url)).arrayBuffer() : null;
    return ab ? decode(ab) : null;
  },
  // Smart Queue scans songs in the background to learn their speed (one at a time)
  scanSong(song) {
    if (busyId || !song || failed.has(song.id)) return false;
    if (song.kickMap && song.kickMap.v === VER) return false;
    scan(song);
    return true;
  },
  // Smart Queue's background scan also fills in the trim
  isDone(song) {
    return !!(song && ((song.kickMap && song.kickMap.v === VER) || failed.has(song.id)));
  },
};
