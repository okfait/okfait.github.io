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
  worker = new Worker(`assets/js/kick-scan.js?v=2.23.0&k=${VER}`);
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
    const res = await new Promise((resolve) => {
      waiters[id] = resolve;
      getWorker().postMessage({ id, x: pcm.x, sr: pcm.sr }, [pcm.x.buffer]);
    });
    if (!res) throw new Error("scan failed");
    const map = { v: VER, t: res.t, s: res.s };
    mem.set(id, { id, t: map.t, s: map.s });
    song.kickMap = map;
    // saved with the song, so it's only ever scanned once
    if (song.blob && window.player && window.player.db) window.player.db.update(id, { kickMap: map }).catch(() => {});
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
    return;
  }
  scan(song);
}
setInterval(check, 500);

window.kickMap = {
  current() {
    const song = window.player && window.player.currentTrack;
    return (song && mem.get(song.id)) || null;
  },
  get busy() {
    return busyId;
  },
  _mem: mem,
};
