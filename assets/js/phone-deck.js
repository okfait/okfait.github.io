// okMUSIC phone engine (v2.21.0)
//
// iPhone Safari has a bug: when a song plays through an <audio> tag that is hooked into the
// sound effects (Web Audio), the SPEED change gets ignored and on some iPhones the effects
// (bass boost, reverb) get skipped too. So on iPhone/iPad we don't use the <audio> tag for the
// music at all: the song is decoded once and played straight inside the effects chain, where
// speed + bass always work.
//
// PhoneDeck looks like an <audio> tag to the rest of the app (play/pause/currentTime/duration/
// playbackRate/src + the same events), so nothing else had to change.
//
// Also:
//  - navigator.audioSession.type = "playback" = keeps playing with the screen locked / tabbed out
//    and ignores the silent switch (like Spotify)
//  - a silent looping <audio> "anchor" keeps iOS's Now Playing (lock screen / Dynamic Island
//    controls) alive; the buttons there are wired up in library-tools.js (media session)
//
// Switch: localStorage okmusic_phone_engine = "0" off, "1" forced on (any device), unset = iPhone/iPad only.

const IS_IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function wanted() {
  let v = null;
  try {
    v = localStorage.getItem("okmusic_phone_engine");
  } catch (e) {}
  if (v === "0") return false;
  if (v === "1") return true;
  return IS_IOS;
}

// ---------------------------------------------------------------- decoded songs (shared)
// the crossfade deck plays the SAME song as the main deck, so decode once and share it
const cache = new Map(); // url -> Promise<AudioBuffer>
let decodeCtx = null;
function decoder(ctx) {
  if (ctx) return ctx;
  if (!decodeCtx) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    decodeCtx = new OAC(2, 1, 44100);
  }
  return decodeCtx;
}
function decode(url, ctx) {
  if (cache.has(url)) {
    const p = cache.get(url);
    cache.delete(url); // move to the end (= most recently used)
    cache.set(url, p);
    return p;
  }
  const p = fetch(url)
    .then((r) => r.arrayBuffer())
    .then(
      (ab) =>
        new Promise((res, rej) => {
          // old Safari only has the callback version
          const pr = decoder(ctx).decodeAudioData(ab, res, rej);
          if (pr && pr.then) pr.then(res, rej);
        })
    );
  p.catch(() => cache.delete(url));
  cache.set(url, p);
  // keep at most 3 songs in memory (current, fading one, next) - phones run out fast
  while (cache.size > 3) cache.delete(cache.keys().next().value);
  return p;
}

// ---------------------------------------------------------------- lock screen anchor
let anchor = null;
function silentWav(seconds) {
  const rate = 8000,
    n = rate * seconds,
    buf = new ArrayBuffer(44 + n),
    v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true); // 8 bit
  str(36, "data");
  v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128); // 128 = silence for 8-bit audio
  return new Blob([buf], { type: "audio/wav" });
}
function getAnchor() {
  if (anchor) return anchor;
  anchor = document.createElement("audio");
  anchor.src = URL.createObjectURL(silentWav(30));
  anchor.loop = true;
  anchor.preload = "auto";
  anchor.setAttribute("playsinline", "");
  anchor.setAttribute("aria-hidden", "true");
  return anchor;
}
function setSession() {
  try {
    if (navigator.audioSession && navigator.audioSession.type !== "playback") navigator.audioSession.type = "playback";
  } catch (e) {}
}

// ---------------------------------------------------------------- the deck
class PhoneDeck extends EventTarget {
  constructor({ anchor: useAnchor = false } = {}) {
    super();
    this.isPhoneDeck = true;
    this.useAnchor = useAnchor;
    this.ctx = null;
    this.out = null;
    this.buffer = null;
    this.node = null;
    this._src = "";
    this._paused = true;
    this._rate = 1;
    this._off = 0; // position (song seconds) when the clock last restarted
    this._t0 = 0; // ctx time when the clock last restarted
    this._load = null;
    this._wantPlay = false;
    this._timer = 0;
    this._gen = 0;
    // plain <audio> things other code sets - kept so nothing breaks
    this.preservesPitch = false;
    this.mozPreservesPitch = false;
    this.webkitPreservesPitch = false;
    this.crossOrigin = "anonymous";
    this.preload = "auto";
    this.volume = 1;
    this.muted = false;
    this.loop = false;
    this.error = null;
  }

  // called by AudioSystem.init once the sound engine exists
  attach(ctx, out) {
    this.ctx = ctx;
    this.out = out;
    setSession();
    // phone call / Siri / other app paused the engine: come back on the next tap or when you return
    const wake = () => {
      if (!this._paused && ctx.state !== "running") ctx.resume().catch(() => {});
    };
    if (!PhoneDeck._woke) {
      PhoneDeck._woke = true;
      document.addEventListener("touchend", wake, { passive: true });
      document.addEventListener("click", wake);
      document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && wake());
    }
    ctx.addEventListener("statechange", () => {
      // iOS pauses the engine for calls etc. - show it as paused so the play button is right
      if (ctx.state === "interrupted" && !this._paused && this.useAnchor) this.pause();
    });
    if (this.useAnchor) {
      // iOS stopped the lock screen player by itself (headphones out etc.) = stop the music too
      getAnchor().addEventListener("pause", () => {
        // only when WE still want it playing (our own pause/play fires this event late)
        if (this._paused || !this._anchorWant || !getAnchor().paused) return;
        this.pause();
        if (window.ui && window.ui.updatePlayBtn) window.ui.updatePlayBtn(false);
      });
    }
    if (this._src && !this.buffer) this._startLoad();
  }

  _fire(type) {
    this.dispatchEvent(new Event(type));
  }

  // ---- src
  get src() {
    return this._src;
  }
  set src(url) {
    url = url ? String(url) : "";
    this._stopNode();
    this._paused = true;
    this._wantPlay = false;
    this._stopTimer();
    this.buffer = null;
    this._off = 0;
    this._src = url;
    this._load = null;
    this._gen++;
    this._fire("emptied");
    if (url) this._startLoad();
  }
  get currentSrc() {
    return this._src;
  }
  removeAttribute(name) {
    if (name === "src") this.src = "";
  }
  setAttribute(name, v) {
    if (name === "src") this.src = v;
  }
  load() {
    if (this._src && !this._load) this._startLoad();
  }
  _startLoad() {
    const gen = this._gen,
      url = this._src;
    this._fire("loadstart");
    this._load = decode(url, this.ctx)
      .then((buf) => {
        if (gen !== this._gen) return;
        this.buffer = buf;
        if (this._off > buf.duration) this._off = 0;
        this._fire("loadedmetadata");
        this._fire("durationchange");
        this._fire("loadeddata");
        this._fire("canplay");
        this._fire("canplaythrough");
        if (this._wantPlay) this._begin();
      })
      .catch((e) => {
        if (gen !== this._gen) return;
        console.warn("phone engine could not read this song", e);
        this.error = { code: 4, message: String(e) };
        this._wantPlay = false;
        this._paused = true;
        this._fire("error");
        this._fire("pause");
      });
    return this._load;
  }

  // ---- state
  get readyState() {
    return this.buffer ? 4 : 0;
  }
  get duration() {
    return this.buffer ? this.buffer.duration : NaN;
  }
  get paused() {
    return this._paused;
  }
  get ended() {
    return !!this.buffer && this._paused && this._off >= this.buffer.duration - 0.01;
  }
  get seeking() {
    return false;
  }
  get currentTime() {
    if (this.node && !this._paused && this.ctx) {
      const t = this._off + (this.ctx.currentTime - this._t0) * this._rate;
      return this.buffer ? Math.min(t, this.buffer.duration) : t;
    }
    return this._off;
  }
  set currentTime(v) {
    v = Math.max(0, parseFloat(v) || 0);
    if (this.buffer) v = Math.min(v, this.buffer.duration);
    this._fire("seeking");
    if (this.node && !this._paused) {
      this._stopNode();
      this._off = v;
      this._startNode();
    } else this._off = v;
    this._fire("timeupdate");
    this._fire("seeked");
  }
  get playbackRate() {
    return this._rate;
  }
  set playbackRate(r) {
    r = parseFloat(r);
    if (!(r > 0) || Math.abs(r - this._rate) < 1e-6) return;
    if (this.node && !this._paused && this.ctx) {
      // restart the clock so the position stays right after a speed change
      this._off = this.currentTime;
      this._t0 = this.ctx.currentTime;
      try {
        this.node.playbackRate.setValueAtTime(r, this.ctx.currentTime);
      } catch (e) {
        this.node.playbackRate.value = r;
      }
    }
    this._rate = r;
    this._fire("ratechange");
  }
  get defaultPlaybackRate() {
    return 1;
  }
  set defaultPlaybackRate(v) {}

  // ---- play / pause
  play() {
    // these 2 must happen right inside your tap or iPhone blocks the sound
    setSession();
    if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {});
    if (this.useAnchor) {
      const a = getAnchor();
      this._anchorWant = true;
      if (a.paused) a.play().catch(() => {});
    }
    if (!this._src) return Promise.reject(new DOMException("no song", "NotSupportedError"));
    if (!this._paused && this.node) return Promise.resolve();
    const wasPaused = this._paused;
    this._paused = false;
    this._wantPlay = true;
    if (wasPaused) this._fire("play");
    if (!this.ctx) return Promise.resolve(); // starts once the engine exists (attach)
    if (this.buffer) {
      this._begin();
      return Promise.resolve();
    }
    this._fire("waiting");
    return (this._load || this._startLoad()).then(() => {
      if (this.error) throw new DOMException("could not read song", "NotSupportedError");
    });
  }
  _begin() {
    if (this._paused || !this.buffer || !this.ctx || this.node) return;
    if (this._off >= this.buffer.duration - 0.01) this._off = 0;
    this._startNode();
    this._startTimer();
    this._fire("playing");
  }
  pause() {
    this._wantPlay = false;
    if (this._paused) return;
    this._off = this.currentTime;
    this._stopNode();
    this._paused = true;
    this._stopTimer();
    if (this.useAnchor && anchor) {
      this._anchorWant = false;
      if (!anchor.paused) anchor.pause();
    }
    this._fire("timeupdate");
    this._fire("pause");
  }
  _startNode() {
    const n = this.ctx.createBufferSource();
    n.buffer = this.buffer;
    n.playbackRate.value = this._rate;
    n.connect(this.out);
    n.onended = () => {
      if (n !== this.node) return; // stopped on purpose (pause / seek / new song)
      this.node = null;
      this._off = this.buffer ? this.buffer.duration : 0;
      this._paused = true;
      this._stopTimer();
      this._fire("timeupdate");
      this._fire("pause");
      this._fire("ended");
    };
    this._t0 = this.ctx.currentTime;
    n.start(0, Math.max(0, this._off));
    this.node = n;
  }
  _stopNode() {
    const n = this.node;
    this.node = null;
    if (!n) return;
    n.onended = null;
    try {
      n.stop();
    } catch (e) {}
    try {
      n.disconnect();
    } catch (e) {}
  }
  _startTimer() {
    this._stopTimer();
    // <audio> sends "timeupdate" ~4x a second; the app runs speed curves / Auto DJ off it
    this._timer = setInterval(() => this._fire("timeupdate"), 250);
  }
  _stopTimer() {
    clearInterval(this._timer);
    this._timer = 0;
  }
  canPlayType(t) {
    return document.createElement("audio").canPlayType(t);
  }
}

window.PhoneDeck = PhoneDeck;
window.phoneEngine = { wanted, isIOS: IS_IOS, anchor: getAnchor };
