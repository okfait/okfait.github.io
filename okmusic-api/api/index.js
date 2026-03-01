const express = require('express');
const cors = require('cors');
const play = require('play-dl');

const app = express();

// Whitelist the origin so okMUSIC can reach the API without CORS issues
app.use(cors({ origin: '*' }));

let isSpotifyAuthorized = false;
async function initSpotify() {
    if (isSpotifyAuthorized) return;
    try {
        if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
            play.setToken({
                spotify: {
                    client_id: process.env.SPOTIFY_CLIENT_ID,
                    client_secret: process.env.SPOTIFY_CLIENT_SECRET,
                    refresh_token: process.env.SPOTIFY_REFRESH_TOKEN || undefined,
                    market: 'US'
                }
            });
            await play.refreshToken();
        } else {
            console.log("No Spotify API Keys found in Env variables. Trying anonymous token...");
            const clientID = await play.getFreeClientID();
            play.setToken({ spotify: { client_id: clientID } });
        }
        isSpotifyAuthorized = true;
        console.log("Spotify successfully configured.");
    } catch (err) {
        console.error('Spotify Init Error:', err);
    }
}

app.get('/api/fetch', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).json({ error: 'Missing Spotify/YouTube URL.' });
    }

    try {
        await initSpotify();

        // play-dl handles both YouTube and Spotify links automatically
        // If it's a Youtube link, it gets stream. If Spotify, it finds the YT equivalent automatically!
        
        let targetUrl = url;
        let pType = play.yt_validate(targetUrl);
        
        if (pType !== 'video') {
             // Handle Spotify Track URL (playlist fetching will be handled later or differently, just track for now to test)
            if (play.sp_validate(targetUrl) === 'track') {
                const spData = await play.spotify(targetUrl);
                // Search for the youtube equivalent
                const searched = await play.search(`${spData.name} ${spData.artists[0].name}`, { limit: 1 });
                if (searched.length === 0) {
                    return res.status(404).json({ error: 'Could not find a YouTube alternative for the Spotify track.' });
                }
                targetUrl = searched[0].url;
            } else if (play.sp_validate(targetUrl) === 'playlist' || play.sp_validate(targetUrl) === 'album') {
                return res.status(400).json({ error: 'Playlist URLs must be sent to /api/playlist.'});
            } else if (pType === 'search' || !targetUrl.startsWith('http')) {
                // If they passed a raw search string (like a track name from a playlist)
                const searched = await play.search(targetUrl, { limit: 1 });
                if (searched.length === 0) return res.status(404).json({ error: 'Could not find video for search query.' });
                targetUrl = searched[0].url;
            } else {
                 return res.status(400).json({ error: 'Invalid URL. Only YouTube videos, Spotify tracks, or search queries are supported.' });
            }
        }

        // Get the audio stream!
        const stream = await play.stream(targetUrl, { discordPlayerCompatibility : true });
        
        // Pass the stream metadata headers
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Transfer-Encoding', 'chunked');

        // Pipe the raw audio directly into the HTTP response object!
        stream.stream.pipe(res);
        
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch audio stream.', details: err.message });
    }
});

app.get('/api/playlist', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Missing Spotify/YouTube Playlist URL.' });

    try {
        await initSpotify();

        let pType = play.yt_validate(url);
        let tracks = [];

        if (pType === 'playlist') {
            const playlist = await play.playlist_info(url, { incomplete: true });
            await playlist.fetch();
            playlist.page(1).forEach(v => tracks.push({ name: v.title, url: v.url }));
        } else if (play.sp_validate(url) === 'playlist') {
            if (play.is_expired()) await play.refreshToken();
            const spPlaylist = await play.spotify(url);
            const all_tracks = await spPlaylist.all_tracks();
            
            // We just return the names + artists so frontend can call /api/fetch sequentially
            tracks = all_tracks.map(t => ({
                name: `${t.name} ${t.artists[0].name}`,
                originalUrl: url // They don't have direct YT URLs yet, /api/fetch will do the conversion!
            }));
        } else if (play.sp_validate(url) === 'album') {
            if (play.is_expired()) await play.refreshToken();
            const spAlbum = await play.spotify(url);
            const all_tracks = await spAlbum.all_tracks();
            tracks = all_tracks.map(t => ({ name: `${t.name} ${t.artists[0].name}` }));
        } else {
             return res.status(400).json({ error: 'Not recognized as a valid YouTube or Spotify playlist.' });
        }

        res.json({ title: "Imported Playlist", tracks: tracks.slice(0, 50) }); // Cap at 50 to avoid massive API abuse
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to parse playlist.', details: err.message });
    }
});

// For local testing (Vercel uses the exported default object)
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`okMUSIC API Server running on port ${PORT}`));
}

module.exports = app;
