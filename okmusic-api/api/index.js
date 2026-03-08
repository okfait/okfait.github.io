// okMUSIC API v6.6 — proxy-embed + playlist + fetch
const express = require('express');
const cors = require('cors');
const play = require('play-dl');

const app = express();

// Whitelist the origin so okMUSIC can reach the API without CORS issues
app.use(cors({ origin: '*' }));

const fs = require('fs');
const path = require('path');

let spAccessToken = null;
let spTokenExpires = 0;

async function getSpotifyToken() {
    if (spAccessToken && Date.now() < spTokenExpires) return spAccessToken;
    
    const client_id = process.env.SPOTIFY_CLIENT_ID;
    const client_secret = process.env.SPOTIFY_CLIENT_SECRET;
    const refresh_token = process.env.SPOTIFY_REFRESH_TOKEN;
    
    if (!client_id || !client_secret) {
        console.warn("Missing Spotify Client ID or Secret in environment.");
        return null;
    }
    
    const basicAuth = Buffer.from(client_id + ':' + client_secret).toString('base64');
    
    // Function to run the fetch
    const fetchToken = async (body) => {
        const res = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + basicAuth
            },
            body: body
        });
        return res.json();
    };

    let data;
    if (refresh_token) {
        data = await fetchToken(new URLSearchParams({ grant_type: 'refresh_token', refresh_token }));
        if (!data.access_token) {
            console.warn("Refresh token failed, falling back to client_credentials...", data.error);
            data = await fetchToken(new URLSearchParams({ grant_type: 'client_credentials' }));
        }
    } else {
        data = await fetchToken(new URLSearchParams({ grant_type: 'client_credentials' }));
    }
    
    if (data.access_token) {
        spAccessToken = data.access_token;
        spTokenExpires = Date.now() + (data.expires_in * 1000) - 60000;
        console.log("Successfully fetched new Spotify Access Token.");
        return spAccessToken;
    }
    
    console.error("Failed to fetch Spotify Access Token:", data);
    return null;
}

// Helper to manually fetch Spotify Track info
async function fetchSpotifyTrack(url) {
    const token = await getSpotifyToken();
    if (!token) throw new Error("No Spotify API Token available.");
    const match = url.match(/track\/([a-zA-Z0-9]+)/);
    if (!match) throw new Error("Invalid Spotify Track URL");
    const res = await fetch(`https://api.spotify.com/v1/tracks/${match[1]}`, {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) throw new Error(`Spotify Track API Error: ${res.status}`);
    const data = await res.json();
    return `${data.name} ${data.artists?.[0]?.name || ''}`.trim();
}

// Helper to manually fetch Spotify Playlist or Album
async function fetchSpotifyPlaylistOrAlbum(url) {
    const token = await getSpotifyToken();
    if (!token) throw new Error("No Spotify API Token available.");
    const match = url.match(/(playlist|album)\/([a-zA-Z0-9]+)/);
    if (!match) throw new Error("Invalid Spotify Playlist/Album URL");
    const type = match[1]; // 'playlist' or 'album'
    
    const res = await fetch(`https://api.spotify.com/v1/${type}s/${match[2]}`, {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) {
        if (res.status === 404) throw new Error("PRIVATE_PLAYLIST");
        const errBody = await res.json().catch(()=>({}));
        throw new Error(`Spotify ${type} API Error: ${errBody.error?.message || res.status}`);
    }
    const data = await res.json();
    
    let tracks = [];
    if (type === 'playlist') {
        if (!data.tracks || !data.tracks.items) {
            console.warn("Spotify Proxy: No tracks found in playlist. Likely private.");
            throw new Error("This playlist is likely PRIVATE. Please make it Public in Spotify settings.");
        }
        tracks = data.tracks.items.map(i => {
            if (!i.track) return null;
            return {
                name: `${i.track.name} - ${i.track.artists?.[0]?.name || 'Unknown Artist'}`,
                originalUrl: url
            };
        }).filter(Boolean);
    } else {
        if (!data.tracks || !data.tracks.items) {
            console.warn("Spotify Proxy: No tracks found in album.");
            throw new Error("Failed to find tracks for this album.");
        }
        tracks = data.tracks.items.map(t => ({
            name: `${t.name} - ${t.artists?.[0]?.name || 'Unknown Artist'}`,
            originalUrl: url
        }));
    }
    
    return { title: data.name, tracks };
}

app.get('/api/fetch', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).json({ error: 'Missing Spotify/YouTube URL.' });
    }

    try {
        let targetUrl = url;
        let pType = play.yt_validate(targetUrl);
        
        // Handle Spotify Track URL or search query
        if (pType !== 'video') {
            if (play.sp_validate(targetUrl) === 'track') {
                targetUrl = await fetchSpotifyTrack(targetUrl);
            }
        }
        
        // V6 Architecture: Utilize Federated Piped API to bypass YouTube Bot Protection on Vercel IPs
        const pipedApiBase = 'https://pipedapi.kavin.rocks';
        let videoId = targetUrl;
        
        if (pType !== 'video') {
            const searchResponse = await fetch(`${pipedApiBase}/search?q=${encodeURIComponent(targetUrl)}&filter=music_songs`);
            if (!searchResponse.ok) throw new Error('Search execution failed on upstream provider.');
            
            const searchData = await searchResponse.json();
            const firstResult = searchData.items.find(item => item.type === 'stream');
            
            if (!firstResult) {
                return res.status(404).json({ error: 'No audio track located for the given query.' });
            }
            videoId = firstResult.url.replace('/watch?v=', '');
        } else {
            try {
               videoId = (new URL(targetUrl)).searchParams.get('v') || targetUrl.split('youtu.be/')[1].split('?')[0]; 
            } catch (e) {
               videoId = targetUrl.split('watch?v=')[1];
            }
        }

        const streamResponse = await fetch(`${pipedApiBase}/streams/${videoId}`);
        if (!streamResponse.ok) throw new Error('Stream metadata extraction failed (Piped API).');
        
        const streamData = await streamResponse.json();
        // Prioritize highest quality audio stream
        const audioStreams = streamData.audioStreams.sort((a, b) => b.bitrate - a.bitrate);
        if (audioStreams.length === 0) throw new Error('No compatible audio streams available.');
        
        const audioFetch = await fetch(audioStreams[0].url);
        if (!audioFetch.ok) throw new Error(`Upstream audio fetch failed: ${audioFetch.statusText}`);

        // Set response headers for native browser audio playback
        res.setHeader('Content-Type', audioStreams[0].mimeType || 'audio/mp4');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Edge cache for popular tracks
        
        const contentLength = audioFetch.headers.get('content-length');
        if (contentLength) {
            res.setHeader('Content-Length', contentLength);
        }

        // Employ Node.js pipeline directly to the Express response (handles backpressure/memory limits)
        const { pipeline } = require('stream/promises');
        const { Readable } = require('stream');
        
        if (audioFetch.body && typeof audioFetch.body.getReader === 'function') {
            // Node 18+ Web Streams Native `fetch`
            await pipeline(Readable.fromWeb(audioFetch.body), res);
        } else {
            // Legacy / `node-fetch` compatibility
            await pipeline(audioFetch.body, res);
        }

    } catch (err) {
        console.error('Streaming pipeline encountered an error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message || 'Internal Server Error during stream extraction and piping.' });
        }
    }
});

app.get('/api/playlist', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Missing Spotify/YouTube Playlist URL.' });

    try {
        let pType = play.yt_validate(url);
        let tracks = [];
        let pTitle = "Imported Playlist";

        if (pType === 'playlist') {
            const playlist = await play.playlist_info(url, { incomplete: true });
            await playlist.fetch();
            pTitle = playlist.title;
            playlist.page(1).forEach(v => tracks.push({ name: v.title, url: v.url }));
        } else if (play.sp_validate(url) === 'playlist' || play.sp_validate(url) === 'album') {
            const data = await fetchSpotifyPlaylistOrAlbum(url);
            pTitle = data.title;
            tracks = data.tracks;
        } else {
             return res.status(400).json({ error: 'Not recognized as a valid YouTube or Spotify playlist.' });
        }

        res.json({ title: pTitle || "Imported Playlist", tracks: tracks.slice(0, 50) }); // Cap at 50 to avoid massive API abuse
    } catch (err) {
        console.error(err);
        if (err.message === "PRIVATE_PLAYLIST" || String(err.message).includes("PRIVATE")) {
            return res.status(403).json({ error: 'This playlist is likely PRIVATE. Please make it Public in Spotify settings.' });
        }
        res.status(500).json({ error: err.message || 'Failed to parse playlist.' });
    }
});

app.get('/api/proxy-embed/playlist/:id', async (req, res) => {
    try {
        const playlistId = req.params.id;
        const response = await fetch(`https://open.spotify.com/embed/playlist/${playlistId}`);
        
        // If Spotify returns 404 for an embed, the playlist is definitely private or deleted.
        if (response.status === 404) {
            return res.status(403).json({ error: "Playlist is Private or Deleted. Cannot generate embed data." });
        }
        
        if (!response.ok) {
            return res.status(response.status).json({ error: `Spotify upstream embed returned ${response.status}` });
        }

        const html = await response.text();
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (err) {
        console.error('Embed Proxy err:', err);
        res.status(500).json({ error: err.message || 'Failed to proxy embed HTML.' });
    }
});

app.get('/api/proxy', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Missing Proxy URL.' });
    try {
        const response = await fetch(decodeURIComponent(url));
        if (!response.ok) throw new Error(`Proxy Error: ${response.status}`);
        
        // Pass Content-Type
        const ct = response.headers.get('content-type');
        if (ct) res.setHeader('Content-Type', ct);
        
        // Convert to buffer and send
        const arrayBuffer = await response.arrayBuffer();
        res.send(Buffer.from(arrayBuffer));
    } catch (err) {
        console.error('Proxy err:', err);
        res.status(500).json({ error: err.message || 'Failed to proxy.' });
    }
});

// For local testing (Vercel uses the exported default object)
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`okMUSIC API Server running on port ${PORT}`));
}

// Debug: Catch-all to see what path Vercel gives Express
app.all('*', (req, res) => {
    res.status(404).json({ debug: true, method: req.method, path: req.path, url: req.url, originalUrl: req.originalUrl });
});

module.exports = app;
