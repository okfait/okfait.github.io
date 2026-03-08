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
        const errBody = await res.json().catch(()=>({}));
        throw new Error(`Spotify ${type} API Error: ${errBody.error?.message || res.status}`);
    }
    const data = await res.json();
    
    let tracks = [];
    if (type === 'playlist') {
        tracks = data.tracks.items.map(i => {
            if (!i.track) return null;
            return {
                name: `${i.track.name} - ${i.track.artists?.[0]?.name || 'Unknown Artist'}`,
                originalUrl: url
            };
        }).filter(Boolean);
    } else {
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
            
            // Search for the query (or track name)
            console.log("Searching YouTube for:", targetUrl);
            try {
                const searched = await play.search(targetUrl, { limit: 1 });
                if (searched.length === 0) {
                    return res.status(404).json({ error: 'Song not found on YouTube.' });
                }
                targetUrl = searched[0].url;
            } catch (searchErr) {
                if (searchErr.message.includes('confirm you\'re not a bot')) {
                    console.error("YouTube SEARCH BLOCK detected.");
                    return res.status(500).json({ 
                        error: 'YouTube blocked this search. TIP: Open the song on YouTube and paste the direct link instead.' 
                    });
                }
                throw searchErr;
            }
        }

        // Get the audio stream
        try {
            const stream = await play.stream(targetUrl, { discordPlayerCompatibility : true });
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Transfer-Encoding', 'chunked');
            stream.stream.pipe(res);
        } catch (streamErr) {
            if (streamErr.message.includes('confirm you\'re not a bot')) {
                console.error("YouTube STREAM BLOCK detected.");
                return res.status(500).json({ error: 'YouTube blocked the stream for this song. Search is restricted on this server.' });
            }
            throw streamErr;
        }
    } catch (err) {
        console.error("Fetch API Error:", err);
        res.status(500).json({ error: err.message || 'Failed to fetch audio stream.' });
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
        res.status(500).json({ error: err.message || 'Failed to parse playlist.' });
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

module.exports = app;
