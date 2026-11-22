// okMUSIC Smart Queue (v2.24.0, off by default - Settings > Sound > Smart Queue)
//
// When it's on, "next song" picks a song with a similar SPEED (BPM) to the one playing, so Auto DJ
// fades between songs that fit together. Songs you've added to Up Next still go first.
//
// Speed comes from the kick map (kick-map.js already finds every kick drum in a song): the most
// common gap between kicks = the beat. Half / double speed count as the same (70 and 140 BPM fit).
// While it's on, songs that were never played get scanned quietly in the background, one at a time.
// Songs with no kick drum at all have no speed - they're only picked when nothing else fits.

const KEY = "sv_smart_queue";
const P = window.player;
const $ = (id) => document.getElementById(id);

let on = false;
try {
  on = localStorage.getItem(KEY) === "true";
} catch (e) {}
const played = new Set();

// BPM from kick times, folded into 80-160 so half/double time match
function bpmOf(song) {
  if (!song) return null;
  if (song._bpm !== undefined) return song._bpm;
  const t = song.kickMap && song.kickMap.t;
  if (!t || t.length < 12) return null; // not scanned yet (don't remember: it may get scanned later)
  const hist = new Float32Array(81); // 80..160
  let n = 0;
  for (let i = 1; i < t.length; i++) {
    const iv = t[i] - t[i - 1];
    if (iv < 0.2 || iv > 2.2) continue;
    let b = 60 / iv;
    while (b < 80) b *= 2;
    while (b >= 160) b /= 2;
    const k = Math.round(b - 80);
    for (let d = -2; d <= 2; d++) if (k + d >= 0 && k + d <= 80) hist[k + d] += d === 0 ? 1 : d === 1 || d === -1 ? 0.6 : 0.25;
    n++;
  }
  let best = -1, bi = 0;
  for (let i = 0; i <= 80; i++) if (hist[i] > best) (best = hist[i]), (bi = i);
  song._bpm = n >= 8 ? 80 + bi : null;
  return song._bpm;
}
// how far apart two speeds are (0 = same), half/double already folded in
function dist(a, b) {
  let d = Math.abs(Math.log(a / b));
  d = Math.min(d, Math.abs(Math.log((a * 2) / b)), Math.abs(Math.log(a / (b * 2))));
  return d;
}

const origNext = P.next.bind(P);
P.next = function () {
  if (!on || (P.queue && P.queue.length)) return origNext();
  const list = P.playlist.length ? P.playlist : window.ui.getFlatList();
  if (list.length < 3) return origNext();
  const cur = P.songs.find((s) => s.id === P.currId);
  const cb = bpmOf(cur);
  if (!cb) return origNext(); // we don't know this song's speed yet: normal order
  if (P.currId) played.add(P.currId);
  let pool = list.filter((id) => !played.has(id) && id !== P.currId);
  if (!pool.length) {
    played.clear();
    played.add(P.currId);
    pool = list.filter((id) => id !== P.currId);
  }
  const scored = pool
    .map((id) => {
      const s = P.songs.find((x) => x.id === id);
      const b = bpmOf(s);
      return { id, d: b ? dist(cb, b) : 9 };
    })
    .sort((a, b) => a.d - b.d);
  // a bit of randomness: any of the closest few (within ~6% of the best match)
  const top = scored.filter((x) => x.d <= scored[0].d + 0.06).slice(0, 4);
  const pick = top[Math.floor(Math.random() * top.length)];
  played.add(pick.id);
  P.play(pick.id);
};

// background: learn the speed of songs that were never played (one every few seconds, only when on)
setInterval(() => {
  if (!on || !window.kickMap || !window.kickMap.scanSong || document.hidden) return;
  if (window.kickMap.busy) return;
  const cur = P.currentTrack;
  if (cur && !window.kickMap.isDone(cur)) return; // the playing song goes first
  const s = (P.songs || []).find((x) => x.blob && !window.kickMap.isDone(x));
  if (s) window.kickMap.scanSong(s);
}, 4000);

function set(v) {
  on = !!v;
  try {
    localStorage.setItem(KEY, on);
  } catch (e) {}
  if ($("smartQueueToggle")) $("smartQueueToggle").checked = on;
  if (on && window.ui) window.ui.showToast("Smart Queue on - it learns each song's speed in the background", 3500);
}
if ($("smartQueueToggle")) $("smartQueueToggle").checked = on;

window.smartQueue = { set, bpmOf, get on() { return on; } };
