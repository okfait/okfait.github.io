// okMUSIC link: connects two devices straight to each other (used by Jam + Phone Remote).
//
// How it finds the other device: PeerJS's free "phone book" server (0.peerjs.com) swaps the
// connection info once, then everything (songs, play/pause, visuals) goes device-to-device.
// If both devices can't reach each other directly (some phone networks), PeerJS falls back to
// its free relay server. No accounts, no database.
//
// The old party mode used Firebase, but that database is locked (every read/write gets
// "permission denied"), which is why party mode never worked.

const PEER_JS = "https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js";
const QR_JS = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";
const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I so codes are easy to type

const scripts = {};
export function loadScript(src) {
  if (!scripts[src])
    scripts[src] = new Promise((ok, bad) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = ok;
      s.onerror = () => {
        delete scripts[src];
        bad(new Error("couldn't load " + src.split("/").pop() + " (offline?)"));
      };
      document.head.appendChild(s);
    });
  return scripts[src];
}

export function newCode(n = 5) {
  const a = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(a, (x) => ABC[x % ABC.length]).join("");
}
export const cleanCode = (c) => (c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const peerId = (kind, code) => `okmusic-${kind}-${code}`.toLowerCase();

// QR code as an <svg> string (drawn locally, the link never leaves the device)
export async function qrSvg(text) {
  await loadScript(QR_JS);
  const q = window.qrcode(0, "M");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
}

export function shareLink(param, code) {
  const u = new URL(location.href);
  u.search = "";
  u.hash = "";
  u.searchParams.set(param, code);
  return u.toString();
}

// ------------------------------------------------------------------ one connection
// Wraps a PeerJS connection: JSON-ish messages, files in chunks, and a clock sync so both
// sides agree on "what time is it" to a few milliseconds.
class Link {
  constructor(conn, onMsg) {
    this.conn = conn;
    this.onMsg = onMsg;
    this.offset = 0; // other side's clock minus ours (ms)
    this.bestRtt = 1e9;
    this.rtts = [];
    this.files = {}; // incoming files being put back together
    this.open = false;
    conn.on("data", (m) => this.recv(m));
  }
  send(m) {
    if (!this.open) return false;
    try {
      this.conn.send(m);
      return true;
    } catch (e) {
      return false;
    }
  }
  // how much is still waiting to go out (so we can skip visual frames when the line is busy)
  backlog() {
    const dc = this.conn.dataChannel;
    return (dc ? dc.bufferedAmount : 0) + (this.conn.bufferSize || 0) * 16000;
  }
  remoteNow() {
    return performance.now() + this.offset;
  }
  ping() {
    this.send({ t: "ping", a: performance.now() });
  }
  startClock() {
    // a quick burst first (to sync fast), then every few seconds to stay synced
    let n = 0;
    const burst = setInterval(() => {
      this.ping();
      if (++n >= 10) clearInterval(burst);
    }, 120);
    this.clockTimer = setInterval(() => this.ping(), 4000);
  }
  stop() {
    clearInterval(this.clockTimer);
    this.open = false;
    try {
      this.conn.close();
    } catch (e) {}
  }
  async sendFile(meta, blob, onPct) {
    const buf = await blob.arrayBuffer();
    const CH = 60000;
    const n = Math.ceil(buf.byteLength / CH);
    this.send({ t: "file", ...meta, size: buf.byteLength, mime: blob.type || "audio/mpeg", n });
    for (let i = 0; i < n; i++) {
      while (this.open && this.backlog() > 1_000_000) await new Promise((r) => setTimeout(r, 15));
      if (!this.open) throw new Error("connection closed");
      this.send({ t: "chunk", id: meta.id, i, d: buf.slice(i * CH, (i + 1) * CH) });
      if (onPct && i % 8 === 0) onPct(Math.round(((i + 1) / n) * 100));
    }
    this.send({ t: "fileEnd", id: meta.id });
    if (onPct) onPct(100);
  }
  recv(m) {
    if (!m || typeof m !== "object") return;
    if (m.t === "ping") return this.send({ t: "pong", a: m.a, h: performance.now() });
    if (m.t === "pong") {
      const b = performance.now();
      const rtt = b - m.a;
      // keep the cleanest measurements (shortest round trips = least guessing)
      this.rtts.push({ rtt, off: m.h - (m.a + b) / 2 });
      if (this.rtts.length > 12) this.rtts.shift();
      const best = this.rtts.reduce((x, y) => (y.rtt < x.rtt ? y : x));
      this.offset = best.off;
      this.bestRtt = best.rtt;
      return;
    }
    if (m.t === "file") {
      this.files[m.id] = { meta: m, parts: new Array(m.n), got: 0 };
      this.onMsg({ t: "fileStart", id: m.id, meta: m }, this);
      return;
    }
    if (m.t === "chunk") {
      const f = this.files[m.id];
      if (!f) return;
      if (!f.parts[m.i]) f.got++;
      f.parts[m.i] = m.d;
      if (f.got % 8 === 0) this.onMsg({ t: "fileProgress", id: m.id, pct: Math.round((f.got / f.meta.n) * 100) }, this);
      return;
    }
    if (m.t === "fileEnd") {
      const f = this.files[m.id];
      delete this.files[m.id];
      if (!f || f.got !== f.meta.n) return this.onMsg({ t: "fileFailed", id: m.id }, this);
      const blob = new Blob(f.parts, { type: f.meta.mime });
      this.onMsg({ t: "fileDone", id: m.id, meta: f.meta, blob }, this);
      return;
    }
    this.onMsg(m, this);
  }
}

// ------------------------------------------------------------------ host / join
async function makePeer(id) {
  await loadScript(PEER_JS);
  return new Promise((ok, bad) => {
    const p = id ? new window.Peer(id, { debug: 0 }) : new window.Peer({ debug: 0 });
    const t = setTimeout(() => bad(new Error("couldn't reach the connect server (internet?)")), 12000);
    p.on("open", () => {
      clearTimeout(t);
      ok(p);
    });
    p.on("error", (e) => {
      clearTimeout(t);
      bad(e);
    });
  });
}

// Host: waits for others to connect. Returns { code, links:Set, close() }
export async function host(kind, { onJoin, onLeave, onMsg }) {
  let peer, code;
  for (let tries = 0; tries < 4 && !peer; tries++) {
    code = newCode();
    try {
      peer = await makePeer(peerId(kind, code));
    } catch (e) {
      if (e && e.type === "unavailable-id") continue; // code taken, roll a new one
      throw e;
    }
  }
  if (!peer) throw new Error("couldn't get a free code, try again");
  const links = new Set();
  peer.on("connection", (conn) => {
    const L = new Link(conn, onMsg);
    conn.on("open", () => {
      L.open = true;
      links.add(L);
      onJoin && onJoin(L);
    });
    const gone = () => {
      if (!links.has(L)) return;
      links.delete(L);
      L.stop();
      onLeave && onLeave(L);
    };
    L.gone = gone;
    conn.on("close", gone);
    conn.on("error", gone);
    // closed tabs don't always say bye: treat 15s of silence as gone
    L.lastSeen = performance.now();
    const origRecv = L.recv.bind(L);
    L.recv = (m) => {
      L.lastSeen = performance.now();
      if (m && m.t === "bye") return gone();
      origRecv(m);
    };
  });
  // the phone book server can drop us when the PC sleeps; reconnect with the same code
  peer.on("disconnected", () => {
    if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1500);
  });
  peer.on("error", (e) => console.warn("link host:", e.type || e));
  const watch = setInterval(() => {
    for (const L of [...links]) if (performance.now() - L.lastSeen > 15000) L.gone();
  }, 5000);
  return {
    code,
    links,
    close() {
      clearInterval(watch);
      links.forEach((L) => L.stop());
      links.clear();
      peer.destroy();
    },
  };
}

// Guest: connects to a host code. Returns { link, close() }. Calls onDrop if it gets cut off.
export async function join(kind, code, { onMsg, onDrop }) {
  const peer = await makePeer(null);
  const conn = peer.connect(peerId(kind, code), { reliable: true, serialization: "binary" });
  const L = new Link(conn, onMsg);
  await new Promise((ok, bad) => {
    const t = setTimeout(() => bad(new Error("no one is hosting " + code + " (check the code)")), 12000);
    conn.on("open", () => {
      clearTimeout(t);
      L.open = true;
      ok();
    });
    peer.on("error", (e) => {
      clearTimeout(t);
      bad(e && e.type === "peer-unavailable" ? new Error("no one is hosting " + code + " (check the code)") : e);
    });
  });
  L.startClock();
  let closed = false;
  const drop = () => {
    if (closed) return;
    closed = true;
    L.stop();
    peer.destroy();
    onDrop && onDrop();
  };
  conn.on("close", drop);
  conn.on("error", drop);
  // keepalive so the host knows we're still here
  const ka = setInterval(() => L.send({ t: "hi" }), 5000);
  return {
    link: L,
    close() {
      clearInterval(ka);
      closed = true;
      L.send({ t: "bye" });
      setTimeout(() => {
        L.stop();
        peer.destroy();
      }, 150);
    },
  };
}
