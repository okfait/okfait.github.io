# okMUSIC helper

Small program that runs on your PC so **Add Songs** in okMUSIC can search and
download songs for you (one song, a Spotify playlist/album, Liked Songs, or a
YouTube playlist).

Why it's needed: YouTube blocks downloads coming from big servers (the old
Vercel downloader kept getting "confirm you're not a bot"). From your own PC it
works, so this does the downloading and hands the songs to the okMUSIC page.

## Use it

1. Install Python once from https://www.python.org/downloads/ (tick **Add python.exe to PATH**).
2. Put `okmusic-helper.py` and `Start okMUSIC Helper.bat` in the same folder.
3. Double-click **Start okMUSIC Helper.bat**. First start installs the downloader (yt-dlp), takes a minute.
4. Leave the black window open, go to okMUSIC → Add Songs. Close the window when you're done.

## Notes

- It only answers okMUSIC (okfait.github.io and localhost), other sites get blocked.
- It updates yt-dlp by itself once a day, because YouTube changes stuff often.
- Songs are saved as the original YouTube audio (.m4a), no quality lost to re-encoding.
- Previews (the play button in Add Songs) stream the song through the helper, nothing gets saved.
- Port: 47823 on 127.0.0.1 (your PC only, not reachable from the internet).

## Run it online instead (nothing to install for anyone) - v1.2.0

The same file works as a server on a hosting site like bot-hosting.net:

1. Make a **Python** deployment, upload `okmusic-helper.py` and `requirements.txt`.
2. Startup / main file: `okmusic-helper.py`. The host installs `requirements.txt` (yt-dlp + deno).
3. Turn on the free HTTPS subdomain (`something.apps.bot-hosting.cloud`).
4. It switches to server mode by itself when the host gives it a `PORT` / `SERVER_PORT`.
   If the host doesn't, set env `OKMUSIC_SERVER=1` and `PORT=<the port the host gave you>`.
5. In okMUSIC → Add Songs → "How to start it" → paste the https link in **Or use an okMUSIC server**.

Notes: only the okMUSIC site can use it (other sites get blocked, `/ping` is open so you can
check it's alive). At most 2 YouTube jobs run at once (free plans have little memory, change
with env `OKMUSIC_JOBS`). If YouTube starts saying "not a bot" for the server, a `cookies.txt`
from a throwaway YouTube account next to the file can help. The PC helper always wins if it's running.
