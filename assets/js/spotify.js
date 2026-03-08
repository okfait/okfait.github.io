import { SPOTIFY_CONFIG } from './spotify-config.js';

export class SpotifyManager {
    constructor() {
        this.accessToken = localStorage.getItem('spotify_access_token');
        this.refreshToken = localStorage.getItem('spotify_refresh_token');
        this.expiresAt = localStorage.getItem('spotify_expires_at');
        this.profile = JSON.parse(localStorage.getItem('spotify_profile'));
    }

    login() {
        const rUri = (SPOTIFY_CONFIG.redirectUri || "").trim();
        console.log("Spotify Login Attempt - Redirecting to:", rUri);
        
        const params = new URLSearchParams({
            client_id: (SPOTIFY_CONFIG.clientId || "").trim(),
            response_type: 'code',
            redirect_uri: rUri,
            scope: SPOTIFY_CONFIG.scopes.join(' '),
            show_dialog: 'true'
        });
        window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
    }

    async handleCallback() {
        const urlParams = new URL(window.location.href).searchParams;
        const code = urlParams.get('code');
        if (!code) return;

        // Clean URL
        window.history.replaceState({}, document.title, SPOTIFY_CONFIG.redirectUri);

        try {
            const body = new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: SPOTIFY_CONFIG.redirectUri,
                client_id: SPOTIFY_CONFIG.clientId,
                client_secret: SPOTIFY_CONFIG.clientSecret
            });

            const res = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body
            });

            const data = await res.json();
            if (data.error) throw new Error(data.error_description || data.error);

            this.saveTokens(data);
            await this.fetchProfile();
            return true;
        } catch (e) {
            console.error('Spotify Auth Error:', e);
            return false;
        }
    }

    saveTokens(data) {
        this.accessToken = data.access_token;
        if (data.refresh_token) this.refreshToken = data.refresh_token;
        // Don't set expiresAt if it's a guest token (we handle that in getGuestToken)
        if (data.expires_in) {
            this.expiresAt = Date.now() + (data.expires_in * 1000);
            localStorage.setItem('spotify_expires_at', this.expiresAt);
        }

        localStorage.setItem('spotify_access_token', this.accessToken);
        if (this.refreshToken) localStorage.setItem('spotify_refresh_token', this.refreshToken);
    }

    async refreshAccessToken() {
        if (!this.refreshToken) return false;

        try {
            const body = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: this.refreshToken,
                client_id: SPOTIFY_CONFIG.clientId,
                client_secret: SPOTIFY_CONFIG.clientSecret
            });

            const res = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body
            });

            const data = await res.json();
            this.saveTokens(data);
            return true;
        } catch (e) {
            console.error('Spotify Refresh Error:', e);
            return false;
        }
    }

    async fetchProfile() {
        if (!this.accessToken) return;

        try {
            const res = await fetch('https://api.spotify.com/v1/me', {
                headers: { 'Authorization': `Bearer ${this.accessToken}` }
            });

            const text = await res.text();
            try {
                this.profile = JSON.parse(text);
            } catch (e) {
                throw new Error("Spotify Profile Parse Error: " + text.slice(0, 100));
            }

            localStorage.setItem('spotify_profile', JSON.stringify(this.profile));
            return this.profile;
        } catch (e) {
            console.error('Spotify Profile Error:', e);
            throw e;
        }
    }

    logout() {
        this.softLogout();
        window.location.reload();
    }

    softLogout() {
        localStorage.removeItem('spotify_access_token');
        localStorage.removeItem('spotify_refresh_token');
        localStorage.removeItem('spotify_expires_at');
        localStorage.removeItem('spotify_profile');
        this.accessToken = null;
        this.refreshToken = null;
        this.expiresAt = null;
        this.profile = null;
    }

    async getValidToken() {
        // If we have a user token that looks valid (not expired), try using it
        if (this.accessToken && !this.isGuest && this.expiresAt) {
            if (Date.now() < this.expiresAt - 60000) {
                return this.accessToken;
            } else {
                // Try refresh if expired
                const refreshed = await this.refreshAccessToken();
                if (refreshed) return this.accessToken;
                // If refresh fails, soft logout and fallback
                console.warn("Failed to refresh token, falling back to guest mode");
                this.softLogout();
            }
        }
        
        // If no user token or it failed/expired, use guest mode
        console.log("Using Spotify Guest Mode...");
        return this.getGuestToken();
    }

    async getGuestToken() {
        try {
            const body = new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: SPOTIFY_CONFIG.clientId,
                client_secret: SPOTIFY_CONFIG.clientSecret
            });

            const res = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body
            });

            const data = await res.json();
            if (data.error) throw new Error(data.error);

            this.isGuest = true;
            return data.access_token;
        } catch (e) {
            console.error('Spotify Guest Token Error:', e);
            return null;
        }
    }

    isConnected() {
        return !!this.accessToken;
    }

    async getTracksFromPlaylist(url) {
        const token = await this.getValidToken();
        if (!token) throw new Error("Spotify not connected");

        // Extract ID: https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoPBqM0
        const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
        const playlistId = match ? match[1] : url;

        try {
            const pRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (pRes.status === 401 || pRes.status === 403) {
                console.warn("Spotify API Auth Failure. Falling back to oEmbed Scraper...");
                if (this.accessToken && !this.isGuest) this.softLogout();
                return await this.scrapeEmbedData(playlistId);
            }

            const pText = await pRes.text();
            let pData;
            try { pData = JSON.parse(pText); } catch (e) {}

            if (!pRes.ok || !pData || !pData.tracks || !pData.tracks.items) {
                console.warn("Spotify API returned error or no tracks. Falling back to oEmbed Scraper.");
                return await this.scrapeEmbedData(playlistId);
            }

            const title = pData.name;
            const tracksData = pData.tracks.items.map(item => {
                if (!item || !item.track) return null;
                return {
                    name: `${item.track.artists?.[0]?.name || 'Unknown Artist'} - ${item.track.name}`,
                    url: item.track.external_urls?.spotify || "",
                    id: item.track.id
                };
            }).filter(Boolean);

            return { title: title, tracks: tracksData };
        } catch (e) {
            console.warn("Spotify standard fetch blocked/failed. Attempting oEmbed fallback.", e);
            return await this.scrapeEmbedData(playlistId);
        }
    }

    async scrapeEmbedData(playlistId) {
        try {
            // Determine the API backend dynamically just like app.js
            const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" 
                ? "http://localhost:3000" 
                : "https://okfait-github-io.vercel.app";

            // Target the Vercel rewrite route which points to open.spotify.com/embed/playlist/
            const res = await fetch(`${API_BASE}/api/proxy-embed/playlist/${playlistId}`);
            if (!res.ok) throw new Error("Backend Embed Proxy returned: " + res.status);
            
            const html = await res.text();
            // Regex to find the <script id="__NEXT_DATA__" type="application/json">...</script>
            const scriptMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
            
            if (!scriptMatch || scriptMatch.length < 2) {
                throw new Error("Could not extract state JSON from Spotify embed page.");
            }
            
            const stateData = JSON.parse(scriptMatch[1]);
            const entity = stateData?.props?.pageProps?.state?.data?.entity;
            
            if (!entity || !entity.trackList) {
                throw new Error("Tracklist missing in embed JSON structure.");
            }
            
            const title = entity.title || entity.name || "Imported Playlist";
            const tracksData = entity.trackList.map(item => {
                let trackName, artistName, trackId;
                if (item.title && item.subtitle) {
                    trackName = item.title;
                    artistName = (typeof item.subtitle === 'string') ? item.subtitle : (Array.isArray(item.subtitle) ? item.subtitle.map(s => s.name || s.title || s).join(', ') : "Unknown");
                    trackId = item.uri ? item.uri.split(':').pop() : crypto.randomUUID();
                } else {
                    return null;
                }
                
                return {
                    name: `${artistName} - ${trackName}`,
                    url: `https://open.spotify.com/track/${trackId}`,
                    id: trackId
                };
            }).filter(Boolean);
            
            if (tracksData.length === 0) throw new Error("Embed proxy parsed 0 tracks.");
            
            console.log(`Successfully scraped ${tracksData.length} tracks via oEmbed proxy.`);
            return { title: title, tracks: tracksData };
            
        } catch (embedError) {
            console.error("Embed Fallback Failed:", embedError);
            throw new Error(`Spotify rejected access entirely. If the playlist is PRIVATE, even the embed proxy cannot read it.`);
        }
    }
}
