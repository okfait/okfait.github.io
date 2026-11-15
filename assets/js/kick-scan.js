// Kick scanner (runs in a background worker, never slows the page).
//
// The old way guessed live "was that a kick?" from the last few milliseconds of sound, so voices,
// 808 notes and synths kept setting off the V2 punch. This reads the WHOLE song once (takes ~1 s,
// then it's saved with the song) and writes down exactly when every kick drum hits.
//
// What makes a kick a kick (checked against real songs: phonk, rap, indie, a voice-only clip):
//   1. the WHOLE bass range (40-300 Hz) jumps up at the same moment - a kick is a vertical stripe
//      in a spectrogram. A voice or a bass/808 note only lights up a few thin lines (its pitch +
//      overtones), so the jump of the MIDDLE bin stays small. (= the "percussive vs harmonic"
//      idea from FitzGerald 2010 median-filter separation, applied to the jump itself)
//   2. it has real DEEP sub (40-95 Hz) compared to how loud the song is. A male voice sits above
//      ~100 Hz, so a rapper's words can't pass this (voice-only clip: 0 false kicks).
//   3. it's loud compared to this song's own big kicks, and the biggest jump in its ~40 ms
//      neighborhood, and at least 100 ms after the last one.
// Result: { t: [seconds...], s: [strength 0.3-1.35...] }, timing within ~2 ms.

function analyzeKicks(x, sr, P = {}) {
  // 1. down to ~8 kHz (we only need the low end): 2 box filters = soft low-pass, then keep every d-th sample
  let d = Math.max(1, Math.round(sr / 8000));
  if (d > 1) {
    const y = new Float32Array(Math.floor(x.length / d));
    let acc = 0;
    const tmp = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      acc += x[i] - (i >= d ? x[i - d] : 0);
      tmp[i] = acc / d;
    }
    acc = 0;
    for (let i = 0, j = 0; i < x.length; i++) {
      acc += tmp[i] - (i >= d ? tmp[i - d] : 0);
      if (i % d === d - 1 && j < y.length) y[j++] = acc / d;
    }
    x = y;
    sr = sr / d;
  }
  let N = 512;
  while (N < sr * 0.11) N *= 2; // ~128 ms window -> ~8 Hz bins
  const hop = Math.max(1, Math.round(sr * 0.008));
  const fps = sr / hop, binHz = sr / N;
  const nF = x.length >= N ? Math.floor((x.length - N) / hop) + 1 : 0;
  if (nF < 30) return { t: [], s: [] };
  const k0 = Math.round(40 / binHz), k1 = Math.round((P.top || 300) / binHz);
  const kb = Math.round((P.sub || 95) / binHz);
  const KB = k1 - k0 + 1;

  // FFT
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const bits = Math.log2(N), rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cosT = new Float64Array(N / 2), sinT = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    cosT[i] = Math.cos((2 * Math.PI * i) / N);
    sinT[i] = -Math.sin((2 * Math.PI * i) / N);
  }
  const re = new Float64Array(N), im = new Float64Array(N);
  const M = new Float32Array(nF * KB); // magnitude in the 40-300 Hz band
  const LOWE = new Float32Array(nF); // energy 40-150 Hz
  const ALLE = new Float32Array(nF); // energy 40 Hz - 4 kHz
  for (let f = 0; f < nF; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) {
      re[rev[i]] = x[o + i] * win[i];
      im[rev[i]] = 0;
    }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let s = 0; s < N; s += size) {
        for (let j = 0; j < half; j++) {
          const a = s + j, b = a + half, ti = j * step;
          const tr = re[b] * cosT[ti] - im[b] * sinT[ti];
          const tm = re[b] * sinT[ti] + im[b] * cosT[ti];
          re[b] = re[a] - tr;
          im[b] = im[a] - tm;
          re[a] += tr;
          im[a] += tm;
        }
      }
    }
    let le = 0, ae = 0;
    for (let k = k0; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      ae += p;
      if (k <= kb) le += p;
      if (k <= k1) M[f * KB + (k - k0)] = Math.sqrt(p);
    }
    LOWE[f] = le;
    ALLE[f] = ae;
  }
  const pct = (arr, q) => {
    const c = Float32Array.from(arr).sort();
    return c[Math.min(c.length - 1, Math.floor(q * c.length))];
  };
  // log compression with a song-level floor (quiet stuff can't make big "jumps")
  const ref = pct(M, 0.99) || 1e-9;
  const fl = ref * (P.floor || 0.003);
  const LG = new Float32Array(nF * KB);
  for (let i = 0; i < M.length; i++) LG[i] = 20 * Math.log10(M[i] + fl);
  const lag = Math.max(2, Math.round((P.lag || 0.064) * fps));
  const O = new Float32Array(nF);
  const rises = new Float32Array(KB);
  for (let f = lag; f < nF; f++) {
    for (let k = 0; k < KB; k++) {
      let mx = -1e9;
      if (P.single !== 0) mx = LG[(f - lag) * KB + k];
      else for (let g = f - lag; g < f; g++) mx = Math.max(mx, LG[g * KB + k]);
      rises[k] = Math.max(0, LG[f * KB + k] - mx);
    }
    rises.sort();
    O[f] = rises[Math.floor(KB * (P.q || 0.5))]; // the MEDIAN bin's jump: only true if most of the range jumped
  }
  const lowRef = pct(LOWE, 0.97) || 1e-12;
  const fullRef = pct(ALLE, 0.9) || 1e-12;
  const wait = Math.round((P.wait || 0.1) * fps);
  const pm = Math.round(0.04 * fps);
  const t = [], raw = [], loud = [];
  let last = -1e9;
  for (let f = 1; f < nF - 1; f++) {
    const v = O[f];
    if (v < (P.thr || 6)) continue;
    let isMax = true;
    for (let dd = -pm; dd <= pm && isMax; dd++) {
      const g = f + dd;
      if (dd && g >= 0 && g < nF && (O[g] > v || (dd < 0 && O[g] === v))) isMax = false;
    }
    if (!isMax) continue;
    let pe = 0;
    for (let g = f; g < Math.min(nF, f + Math.round(0.06 * fps)); g++) pe = Math.max(pe, LOWE[g]);
    // the deep bass has to JUMP, not just be there (a snare over a ringing 808 has lots of sub too)
    const relSong = pe / lowRef; // vs this song's loud bass
    const relAll = pe / fullRef; // vs this song's overall loudness
    const subRise = (pe - LOWE[f - lag]) / lowRef; // did the deep bass itself jump?
    if (P.dbg) P.dbg.push({ time: (f * hop + N / 2) / sr, v, relSong, relAll, subRise });
    if (relSong < (P.relSong ?? 0.2) || relAll < (P.relAll ?? 0.012)) continue;
    // a snare / clap over a ringing 808: the deep bass doesn't jump and the hit is only a small
    // jump. A kick on top of a ringing 808 still makes the whole low end jump hard (10+ dB).
    if (subRise < 0.05 && v < 10) continue;
    if (f - last < wait) {
      if (raw.length && v > raw[raw.length - 1]) {
        t.pop();
        raw.pop();
        loud.pop();
      } else continue;
    }
    last = f;
    // the jump is measured when the hit reaches the middle of the window
    t.push((f * hop + N / 2) / sr);
    raw.push(v);
    loud.push(relSong);
  }
  const top = raw.length ? pct(raw, 0.9) : 1;
  return {
    t: t.map((v) => Math.round(v * 1000) / 1000),
    // strength: how hard it jumped (vs this song's big kicks) + how loud the boom is
    s: raw.map((v, i) => Math.round(Math.min(1.35, 0.3 + (0.55 * v) / top + 0.35 * Math.min(1, loud[i])) * 100) / 100),
  };
}
if (typeof self !== "undefined" && typeof window === "undefined") {
  self.onmessage = (e) => {
    const { id, x, sr } = e.data;
    try {
      const r = analyzeKicks(x, sr);
      self.postMessage({ id, t: r.t, s: r.s });
    } catch (err) {
      self.postMessage({ id, err: String(err) });
    }
  };
}
if (typeof module !== "undefined") module.exports = { analyzeKicks };
