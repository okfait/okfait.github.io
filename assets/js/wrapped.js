// okMUSIC Wrapped (v2.25.0) - ••• → Your Wrapped. Only shows when you open it.
//
// Counts what you actually listen to, from now on (there was no play history before this):
//  - listening time: real seconds the music was playing (a 0.8x slowed song counts real time)
//  - a "play" = you listened to at least 30 s of a song (or most of a short one)
// Everything stays on this device (localStorage okmusic_stats).
//
// stats = { since, total, songs: { id: [plays, seconds, name] }, months: { "2026-11": { id: [plays, seconds, name] } },
//           days: { "2026-11-23": seconds }, hours: [24 x seconds] }

const KEY = "okmusic_stats";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && s.songs) return s;
  } catch (e) {}
  return { since: Date.now(), total: 0, songs: {}, months: {}, days: {}, hours: new Array(24).fill(0) };
}
let st = load();
let dirty = !localStorage.getItem(KEY); // first time: remember the "counting since" date
function save() {
  if (!dirty) return;
  dirty = false;
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
  } catch (e) {}
}
setInterval(save, 10000);
addEventListener("pagehide", save);
document.addEventListener("visibilitychange", () => document.hidden && save());

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

// ---------------------------------------------------------------- counting
const cur = { id: null, heard: 0, counted: false, last: 0 };
function tick() {
  const a = window.audioSys && window.audioSys.audio;
  const P = window.player;
  if (!a || !P || document.body.classList.contains("remote-mode")) return;
  const now = performance.now();
  const dt = cur.last ? (now - cur.last) / 1000 : 0;
  cur.last = now;
  const t = P.currentTrack;
  if (!t || !t.id || a.paused) return;
  if (t.id !== cur.id) {
    cur.id = t.id;
    cur.heard = 0;
    cur.counted = false;
  }
  const add = Math.min(dt, 1.5); // timers can stall: never count a long gap
  if (add <= 0) return;
  const d = new Date();
  const name = String(t.name || "Song").slice(0, 120);
  const mk = monthKey(d);
  const m = st.months[mk] || (st.months[mk] = {});
  const all = st.songs[t.id] || (st.songs[t.id] = [0, 0, name]);
  const mon = m[t.id] || (m[t.id] = [0, 0, name]);
  all[1] += add;
  mon[1] += add;
  all[2] = mon[2] = name;
  st.total += add;
  const dk = dayKey(d);
  st.days[dk] = (st.days[dk] || 0) + add;
  st.hours[d.getHours()] += add;
  cur.heard += add;
  const dur = a.duration || 0;
  if (!cur.counted && (cur.heard >= 30 || (dur > 0 && cur.heard >= dur * 0.8 / (a.playbackRate || 1)))) {
    cur.counted = true;
    all[0]++;
    mon[0]++;
  }
  dirty = true;
}
setInterval(tick, 1000);

// ---------------------------------------------------------------- numbers
function pick(range) {
  const d = new Date();
  if (range === "month") return st.months[monthKey(d)] || {};
  return st.songs;
}
function topSongs(map, n = 5) {
  return Object.entries(map)
    .map(([id, [plays, secs, name]]) => ({ id, plays, secs, name }))
    .filter((x) => x.secs > 5)
    .sort((a, b) => b.plays - a.plays || b.secs - a.secs)
    .slice(0, n);
}
function topArtists(map, n = 3) {
  const by = {};
  for (const [, [plays, secs, name]] of Object.entries(map)) {
    const parts = window.songNames ? window.songNames.splitName(name) : { artist: "" };
    const artist = (parts.artist || "").trim();
    if (!artist) continue;
    const k = artist.toLowerCase();
    const x = by[k] || (by[k] = { name: artist, plays: 0, secs: 0 });
    x.plays += plays;
    x.secs += secs;
  }
  return Object.values(by)
    .sort((a, b) => b.secs - a.secs)
    .slice(0, n);
}
function totalFor(range) {
  if (range !== "month") return st.total;
  const mk = monthKey(new Date());
  let s = 0;
  for (const [k, v] of Object.entries(st.days)) if (k.startsWith(mk)) s += v;
  return s;
}
function streak() {
  // days in a row with 1+ minute of music, counting back from today (or yesterday)
  let n = 0;
  const d = new Date();
  if ((st.days[dayKey(d)] || 0) < 60) d.setDate(d.getDate() - 1);
  while ((st.days[dayKey(d)] || 0) >= 60) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}
function bestHour() {
  let h = 0;
  for (let i = 1; i < 24; i++) if (st.hours[i] > st.hours[h]) h = i;
  return st.hours[h] > 60 ? h : -1;
}
function hourText(h) {
  const label = `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
  if (h >= 0 && h < 5) return [label, "night owl 🦉", "most of your music happens way past midnight"];
  if (h < 11) return [label, "early bird 🌅", "you start the day with music"];
  if (h < 17) return [label, "daytime listener ☀️", "music while you get stuff done"];
  if (h < 21) return [label, "evening vibes 🌆", "after-school / after-work sessions"];
  return [label, "late night 🌙", "the best songs hit different at night"];
}
const mins = (s) => Math.round(s / 60);
const fmtMins = (s) => {
  const m = mins(s);
  return m >= 600 ? `${Math.round(m / 60)} h` : `${m.toLocaleString()} min`;
};

// ---------------------------------------------------------------- sheet
let range = "month";
function render() {
  tick();
  const box = $("wrBody");
  if (!box) return;
  const P = window.player;
  const songs = pick(range);
  const top = topSongs(songs);
  const arts = topArtists(songs);
  const total = totalFor(range);
  const hr = bestHour();
  const s = streak();
  const art = (id) => {
    const x = P && P.songs ? P.songs.find((q) => q.id === id) : null;
    return x && typeof x.art === "string" && x.art.length < 2e6 ? x.art : "";
  };
  const title = (name) => {
    const p = window.songNames ? window.songNames.splitName(name) : { title: name, artist: "" };
    return { t: p.title || name, a: p.artist || "" };
  };
  const since = new Date(st.since).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const monthName = new Date().toLocaleDateString(undefined, { month: "long" });
  const seg = `
    <div class="seg wr-seg">
      <button data-r="month" class="${range === "month" ? "active" : ""}">${esc(monthName)}</button>
      <button data-r="all" class="${range === "all" ? "active" : ""}">All time</button>
    </div>`;
  if (total < 60) {
    box.innerHTML = `${seg}
      <div class="wr-empty"><i class="fa-solid fa-headphones"></i>
        <b>Nothing here yet</b>
        <p>Your Wrapped fills up as you listen. okMUSIC started counting on ${esc(since)} - play some songs and come back.</p>
      </div>`;
  } else {
    const ht = hr >= 0 ? hourText(hr) : null;
    box.innerHTML = `${seg}
      <div class="wr-hero">
        <small>${range === "month" ? "This month you listened" : "You've listened"}</small>
        <div class="wr-big">${esc(fmtMins(total))}</div>
        <small>${mins(total) >= 60 ? `that's ${(total / 3600).toFixed(1)} hours of music` : "of music"}</small>
      </div>
      ${
        top.length
          ? `<div class="wr-card"><div class="wr-h">Top songs</div>
        ${top
          .map((x, i) => {
            const n = title(x.name);
            const a = art(x.id);
            return `<div class="wr-song">
              <span class="wr-rank">${i + 1}</span>
              <span class="wr-art" ${a ? `style="background-image:url('${a.replace(/'/g, "%27")}')"` : ""}>${a ? "" : '<i class="fa-solid fa-music"></i>'}</span>
              <span class="wr-name"><b>${esc(n.t)}</b>${n.a ? `<small>${esc(n.a)}</small>` : ""}</span>
              <span class="wr-num"><b>${x.plays}</b><small>plays</small></span>
            </div>`;
          })
          .join("")}</div>`
          : ""
      }
      <div class="wr-grid">
        ${
          arts.length
            ? `<div class="wr-tile wr-tile-wide"><small>Top artist</small><b>${esc(arts[0].name)}</b><span>${esc(fmtMins(arts[0].secs))}${
                arts[1] ? ` · then ${esc(arts[1].name)}${arts[2] ? `, ${esc(arts[2].name)}` : ""}` : ""
              }</span></div>`
            : ""
        }
        ${ht ? `<div class="wr-tile"><small>You're a</small><b>${esc(ht[1])}</b><span>most at ${esc(ht[0])}</span></div>` : ""}
        <div class="wr-tile"><small>Streak</small><b>${s} day${s === 1 ? "" : "s"} 🔥</b><span>in a row with music</span></div>
        <div class="wr-tile"><small>Songs played</small><b>${Object.values(songs).filter((x) => x[0] > 0).length}</b><span>different ones</span></div>
      </div>
      <p class="jam-hint wr-since">Counting since ${esc(since)} · only saved on this device</p>`;
  }
  box.querySelectorAll(".wr-seg button").forEach((b) =>
    b.addEventListener("click", () => {
      range = b.dataset.r;
      render();
    }),
  );
}

function toggle(force) {
  if (!$("wrSheet")) {
    const el = document.createElement("div");
    el.id = "wrSheet";
    el.className = "jam-sheet";
    el.innerHTML = `
      <div class="jam-card wr-cardbox">
        <div class="jam-head">
          <div class="jam-title"><i class="fa-solid fa-chart-simple"></i> Your Wrapped</div>
          <button class="tuner-icon-btn" id="wrClose" title="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div id="wrBody"></div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener("click", (e) => e.target === el && toggle(false));
    $("wrClose").onclick = () => toggle(false);
  }
  const el = $("wrSheet");
  const open = force === undefined ? !el.classList.contains("open") : force;
  el.classList.toggle("open", open);
  if (open) render();
}

window.wrapped = { open: () => toggle(true), toggle, _stats: () => st };
