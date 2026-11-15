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
