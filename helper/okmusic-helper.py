"""
okMUSIC helper - runs on your PC so okMUSIC can find and save songs for you.

Why this exists: YouTube blocks song downloads that come from big servers
(that's why the old Vercel downloader kept failing with "confirm you're not a
bot"). From your own PC and home internet it works fine, so this little program
does the downloading and hands the song straight to the okMUSIC page.

How to use: double-click "Start okMUSIC Helper.bat" (or run: py okmusic-helper.py)
and leave the black window open while you add songs. Close it when you're done.

It only answers okMUSIC (okfait.github.io and localhost), nobody else.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.2.0"
# SERVER MODE (v1.2.0): on a hosting site (bot-hosting.net etc.) it notices the host's
# PORT / SERVER_PORT and listens for the internet instead of just this PC.
CLOUD_PORT = os.environ.get("PORT") or os.environ.get("SERVER_PORT")
SERVER_MODE = bool(CLOUD_PORT) or os.environ.get("OKMUSIC_SERVER") == "1"
PORT = int(CLOUD_PORT or 47823)
HOST = "0.0.0.0" if SERVER_MODE else "127.0.0.1"
# a hosted server only has a little memory: only this many YouTube jobs at the same time
JOBS = threading.BoundedSemaphore(int(os.environ.get("OKMUSIC_JOBS", "2" if SERVER_MODE else "8")))
ALLOWED_ORIGINS = re.compile(
    r"^(https://okfait\.github\.io|https?://(localhost|127\.0\.0\.1)(:\d+)?)$"
)
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"
)
AUDIO_TYPES = {"m4a": "audio/mp4", "webm": "audio/webm", "opus": "audio/ogg", "mp3": "audio/mpeg"}

# --------------------------------------------------------------------- setup


def ensure_ytdlp():
    """Installs / updates yt-dlp (the downloader) the first time, and once a day after."""
    stamp = os.path.join(tempfile.gettempdir(), "okmusic-helper-ytdlp-check")
    try:
        import yt_dlp  # noqa: F401

        fresh = os.path.exists(stamp) and (os.path.getmtime(stamp) > __import__("time").time() - 86400)
        if fresh:
            return
        print("  checking for downloader updates...")
    except ImportError:
        print("  first start: installing the downloader (yt-dlp), takes a minute...")
    # YouTube changes stuff often, an old yt-dlp is the #1 reason downloads break
    pkgs = ["yt-dlp[default]"] + (["deno"] if SERVER_MODE and not shutil.which("node") else [])
    base = [sys.executable, "-m", "pip", "install", "-q", "-U"]
    r = subprocess.run(base + ["--user"] + pkgs, capture_output=True, text=True)
    if r.returncode != 0:  # inside a container / venv "--user" isn't allowed, try without
        r = subprocess.run(base + pkgs, capture_output=True, text=True)
    if r.returncode != 0:
        print("  couldn't update yt-dlp:\n" + (r.stderr or r.stdout)[-800:])
    else:
        open(stamp, "w").close()


def deno_path():
    """deno from pip (the 'deno' package ships the program) - hosting sites usually don't have node."""
    p = shutil.which("deno")
    if p:
        return p
    try:
        import deno

        return deno.find_deno_bin()
    except Exception:  # noqa: BLE001
        return None


_DENO = None


def ytdlp_base():
    global _DENO
    cmd = [sys.executable, "-m", "yt_dlp", "--no-warnings", "--no-progress"]
    # new YouTube needs a javascript runtime to unlock the audio
    if _DENO is None:
        _DENO = deno_path() or ""
    if _DENO:
        cmd += ["--js-runtimes", "deno:" + _DENO]
    elif shutil.which("node"):
        cmd += ["--js-runtimes", "node"]
    # optional: cookies.txt next to this file (a throwaway YouTube account) if YouTube blocks the server
    ck = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies.txt")
    if os.path.exists(ck):
        cmd += ["--cookies", ck]
    return cmd


def run_ytdlp(args, timeout=180):
    with JOBS:
        r = subprocess.run(ytdlp_base() + args, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        msg = (r.stderr or r.stdout or "unknown error").strip().splitlines()
        err = next((l for l in reversed(msg) if "ERROR" in l), msg[-1] if msg else "unknown error")
        if "No module named yt_dlp" in err:
            err = "the downloader isn't installed yet, close the helper and start it again"
        elif "Sign in to confirm" in err or "not a bot" in err:
            err = (
                "YouTube is blocking the okMUSIC server right now (bot check)"
                if SERVER_MODE
                else "YouTube wants a captcha from this PC right now, try again in a bit"
            )
        raise RuntimeError(err.replace("ERROR: ", "")[:300])
    return r.stdout


# ------------------------------------------------------------------- matching

JUNK = re.compile(
    r"\((official|lyric|lyrics|audio|video|visuali[sz]er|hd|hq|4k|remaster(ed)?[^)]*)[^)]*\)|"
    r"\[(official|lyric|lyrics|audio|video|visuali[sz]er|hd|hq|4k)[^\]]*\]",
    re.I,
)


def words(s):
    s = JUNK.sub(" ", s or "").lower()
    s = re.sub(r"\b(feat|ft|featuring|prod)\b\.?", " ", s)
    return [w for w in re.findall(r"[a-z0-9À-ɏЀ-ӿ]+", s) if len(w) > 1]


def score(entry, query, want_dur):
    """Higher = better match. Looks at the title words and how close the length is."""
    q = set(words(query))
    t = set(words((entry.get("title") or "") + " " + (entry.get("channel") or entry.get("uploader") or "")))
    s = len(q & t) / max(1, len(q)) * 10
    title = (entry.get("title") or "").lower()
    for bad in ("live", "cover", "karaoke", "instrumental", "8d", "nightcore", "reverb", "slowed", "sped up", "remix", "1 hour", "10 hours"):
        if bad in title and bad not in query.lower():
            s -= 4
    if "topic" in (entry.get("channel") or entry.get("uploader") or "").lower():
        s += 2  # "Artist - Topic" channels are the clean album audio
    if want_dur and entry.get("duration"):
        diff = abs(entry["duration"] - want_dur)
        s += 4 if diff <= 3 else 2 if diff <= 10 else -2 if diff > 40 else 0
    dur = entry.get("duration") or 0
    if dur and (dur < 45 or dur > 15 * 60):
        s -= 5
    return s


def search(query, n=6):
    out = run_ytdlp(["--flat-playlist", "-J", f"ytsearch{n}:{query}"], timeout=60)
    data = json.loads(out)
    res = []
    for e in data.get("entries") or []:
        if not e or not e.get("id"):
            continue
        res.append(
            {
                "id": e["id"],
                "title": e.get("title") or "",
                "channel": e.get("channel") or e.get("uploader") or "",
                "duration": e.get("duration") or 0,
                "thumb": f"https://i.ytimg.com/vi/{e['id']}/mqdefault.jpg",
            }
        )
    return res


def best_match(query, want_dur=None):
    found = search(query + " audio", 6)
    if not found:
        raise RuntimeError("no results on YouTube for: " + query)
    return max(found, key=lambda e: score(e, query, want_dur))


# ------------------------------------------------------------- song lists


def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read().decode("utf-8", "replace")


def spotify_list(url):
    m = re.search(r"(playlist|album|track)[/:]([A-Za-z0-9]{10,})", url)
    if not m:
        raise RuntimeError("that doesn't look like a Spotify playlist/album/song link")
    kind, sid = m.group(1), m.group(2)
    html = http_get(f"https://open.spotify.com/embed/{kind}/{sid}")
    nd = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
    if not nd:
        raise RuntimeError("Spotify changed their page, couldn't read the song list")
    props = json.loads(nd.group(1)).get("props", {}).get("pageProps", {})
    entity = (((props.get("state") or {}).get("data") or {}).get("entity")) or None
    if not entity:
        raise RuntimeError(
            "Spotify won't show this list. If the playlist is private, make it public "
            "(... > Make public) for a sec. Spotify-made mixes (Daily Mix, Discover Weekly) can't be read."
        )
    title = entity.get("title") or entity.get("name") or "Spotify"
    imgs = (entity.get("visualIdentity") or {}).get("image") or []
    image = next((i["url"] for i in imgs if i.get("maxWidth") == 300), imgs[0]["url"] if imgs else "")
    items = entity.get("trackList") or ([entity] if kind == "track" else [])
    tracks = []
    for it in items:
        name = it.get("title") or it.get("name")
        artist = it.get("subtitle")
        if isinstance(artist, list):
            artist = ", ".join(a.get("name", "") if isinstance(a, dict) else str(a) for a in artist)
        if not artist and kind == "track":
            artist = ", ".join(a.get("name", "") for a in entity.get("artists") or [])
        if not name:
            continue
        dur = it.get("duration") or 0
        tracks.append(
            {
                "title": name,
                "artist": (artist or "").replace(" ", " "),
                "duration": round(dur / 1000) if dur > 10000 else dur,
                "spotify": (it.get("uri") or "").split(":")[-1],
                # an album's songs all share its cover; playlist songs get the video thumbnail later
                "art": image if kind != "playlist" else "",
            }
        )
    return {"title": title, "image": image, "source": "spotify", "tracks": tracks}


def youtube_list(url):
    data = json.loads(run_ytdlp(["--flat-playlist", "-J", url], timeout=120))
    entries = data.get("entries") or [data]
    tracks = []
    for e in entries:
        if not e or not e.get("id"):
            continue
        tracks.append(
            {
                "title": e.get("title") or "",
                "artist": e.get("channel") or e.get("uploader") or "",
                "duration": e.get("duration") or 0,
                "youtube": e["id"],
            }
        )
    return {"title": data.get("title") or "YouTube", "source": "youtube", "tracks": tracks}


# ---------------------------------------------------------------- download


_stream_cache = {}  # video id -> (direct audio url, time found)


def stream_url(video_id):
    """Direct link to the song's audio on YouTube, for quick previews (no full download)."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,20}", video_id or ""):
        raise RuntimeError("bad video id")
    hit = _stream_cache.get(video_id)
    if hit and time.time() - hit[1] < 3 * 3600:
        return hit[0]
    out = run_ytdlp(["-g", "-f", "bestaudio[ext=m4a]/bestaudio", "--no-playlist", f"https://www.youtube.com/watch?v={video_id}"], timeout=60)
    url = out.strip().splitlines()[0]
    _stream_cache[video_id] = (url, time.time())
    return url


def download(video_id):
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,20}", video_id or ""):
        raise RuntimeError("bad video id")
    tmp = tempfile.mkdtemp(prefix="okmusic-")
    try:
        run_ytdlp(
            [
                "-f", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
                "--no-playlist",
                "-o", os.path.join(tmp, "song.%(ext)s"),
                f"https://www.youtube.com/watch?v={video_id}",
            ],
            timeout=300,
        )
        files = [f for f in os.listdir(tmp) if f.startswith("song.") and not f.endswith(".part")]
        if not files:
            raise RuntimeError("download finished but no file showed up")
        path = os.path.join(tmp, files[0])
        ext = files[0].rsplit(".", 1)[-1].lower()
        with open(path, "rb") as f:
            return f.read(), ext
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------------ server


class Handler(BaseHTTPRequestHandler):
    server_version = "okmusic-helper/" + VERSION

    def log_message(self, fmt, *args):
        pass  # keep the window quiet, we print our own lines

    def cors(self):
        origin = self.headers.get("Origin") or ""
        if ALLOWED_ORIGINS.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Expose-Headers", "X-Title, X-Video-Id, X-Ext")
        return origin

    def allowed(self):
        origin = self.headers.get("Origin")
        # no Origin = typed into the address bar / curl on this PC, that's fine
        # (on a public server only /ping works without it, so random people can't use it)
        if origin is None:
            return not SERVER_MODE or self.path.startswith("/ping")
        return ALLOWED_ORIGINS.match(origin)

    def do_OPTIONS(self):
        self.send_response(204 if self.allowed() else 403)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.allowed():
            return self.send_json({"error": "not allowed"}, 403)
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        try:
            if u.path == "/ping":
                return self.send_json({"ok": True, "app": "okmusic-helper", "version": VERSION, "server": SERVER_MODE})
            if u.path == "/search":
                return self.send_json({"results": search(q.get("q", ""), min(10, int(q.get("n", 6))))})
            if u.path == "/match":
                dur = float(q["dur"]) if q.get("dur") else None
                return self.send_json(best_match(q.get("q", ""), dur))
            if u.path == "/list":
                link = q.get("url", "")
                if "spotify" in link:
                    return self.send_json(spotify_list(link))
                if "youtu" in link:
                    return self.send_json(youtube_list(link))
                return self.send_json({"error": "paste a Spotify or YouTube link"}, 400)
            if u.path == "/download":
                vid = q.get("id")
                title = q.get("title") or ""
                if not vid:
                    m = best_match(q.get("q", ""), float(q["dur"]) if q.get("dur") else None)
                    vid, title = m["id"], title or m["title"]
                print(f"  downloading: {title or vid}")
                data, ext = download(vid)
                self.send_response(200)
                self.cors()
                self.send_header("Content-Type", AUDIO_TYPES.get(ext, "application/octet-stream"))
                self.send_header("Content-Length", str(len(data)))
                self.send_header("X-Title", urllib.parse.quote(title))
                self.send_header("X-Video-Id", vid)
                self.send_header("X-Ext", ext)
                self.end_headers()
                self.wfile.write(data)
                print(f"  done ({len(data) // 1024} KB)")
                return
            if u.path == "/resolve":
                # which YouTube video a song name matches (used before previewing playlist songs)
                return self.send_json(best_match(q.get("q", ""), float(q["dur"]) if q.get("dur") else None))
            if u.path == "/preview":
                vid = q.get("id", "")
                url = stream_url(vid)
                # pass the audio through so the page can play it (keeps seeking working)
                headers = {"User-Agent": UA}
                if self.headers.get("Range"):
                    headers["Range"] = self.headers["Range"]
                try:
                    up = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30)
                except urllib.error.HTTPError as e:
                    if e.code == 403:  # link went stale, get a fresh one
                        _stream_cache.pop(vid, None)
                        up = urllib.request.urlopen(urllib.request.Request(stream_url(vid), headers=headers), timeout=30)
                    else:
                        raise
                with up:
                    self.send_response(up.status)
                    self.cors()
                    for h in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"):
                        if up.headers.get(h):
                            self.send_header(h, up.headers[h])
                    self.end_headers()
                    try:
                        while True:
                            chunk = up.read(64 * 1024)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                        pass  # preview stopped / skipped, totally normal
                return
            if u.path == "/thumb":
                vid = q.get("id", "")
                if not re.fullmatch(r"[A-Za-z0-9_-]{6,20}", vid):
                    return self.send_json({"error": "bad id"}, 400)
                req = urllib.request.Request(f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg", headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=15) as r:
                    img = r.read()
                self.send_response(200)
                self.cors()
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(img)))
                self.end_headers()
                self.wfile.write(img)
                return
            return self.send_json({"error": "unknown"}, 404)
        except Exception as e:  # noqa: BLE001
            print("  problem:", e)
            try:
                return self.send_json({"error": str(e)}, 500)
            except Exception:  # noqa: BLE001
                pass


def main():
    os.system("")  # turns on colours in the old Windows console
    print("\n  okMUSIC helper v" + VERSION)
    ensure_ytdlp()
    try:
        srv = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        if SERVER_MODE:
            raise
        print("\n  the helper is already running in another window, you're good.")
        input("  press Enter to close this one...")
        return
    if SERVER_MODE:
        print(f"  server mode: listening on {HOST}:{PORT} (deno: {deno_path() or 'none'})", flush=True)

        def updater():  # keep yt-dlp fresh while the server stays up for days
            while True:
                time.sleep(6 * 3600)
                ensure_ytdlp()

        threading.Thread(target=updater, daemon=True).start()
    else:
        print("\n  \033[92mready!\033[0m go back to okMUSIC and add songs.")
        print("  keep this window open while downloading. close it when you're done.\n")
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
