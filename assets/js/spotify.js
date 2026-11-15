import { SPOTIFY_CONFIG } from './spotify-config.js?v=4';

// --- Helpers for the secret-free ("PKCE") login ---------------------------
// The site runs in the browser, so it must NEVER hold a client secret.
// Instead, each login makes a random one-time code and a scrambled version of it.
function randomString(len = 64) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const arr = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(arr, (x) => chars[x % chars.length]).join('');
}

async function sha256Base64Url(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

export class SpotifyManager {
    constructor() {
        this.accessToken = localStorage.getItem('spotify_access_token');
        this.refreshToken = localStorage.getItem('spotify_refresh_token');
        this.expiresAt = localStorage.getItem('spotify_expires_at');
        this.profile = JSON.parse(localStorage.getItem('spotify_profile'));
    }

    async login() {
        const rUri = (SPOTIFY_CONFIG.redirectUri || "").trim();
        console.log("Spotify Login Attempt - Redirecting to:", rUri);

        const verifier = randomString(64);
        const challenge = await sha256Base64Url(verifier);
        localStorage.setItem('spotify_code_verifier', verifier);

        const params = new URLSearchParams({
            client_id: (SPOTIFY_CONFIG.clientId || "").trim(),
            response_type: 'code',
            redirect_uri: rUri,
            scope: SPOTIFY_CONFIG.scopes.join(' '),
            code_challenge_method: 'S256',
            code_challenge: challenge,
            show_dialog: 'true'
        });
        window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
    }

    async handleCallback() {
        const urlParams = new URL(window.location.href).searchParams;
        const code = urlParams.get('code');
        const authError = urlParams.get('error');

        if (authError) {
            // e.g. the user pressed "Cancel" on the Spotify page
            console.warn('Spotify login was not completed:', authError);
            window.history.replaceState({}, document.title, SPOTIFY_CONFIG.redirectUri);
            return false;
        }
        if (!code) return;

        // Clean URL
        window.history.replaceState({}, document.title, SPOTIFY_CONFIG.redirectUri);

        try {
            const verifier = localStorage.getItem('spotify_code_verifier');
            if (!verifier) throw new Error('Missing login verifier - please press Connect Spotify again.');

            const body = new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: SPOTIFY_CONFIG.redirectUri,
                client_id: SPOTIFY_CONFIG.clientId,
                code_verifier: verifier
            });

            const res = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body
            });

            const data = await res.json();
            if (data.error) throw new Error(data.error_description || data.error);

            localStorage.removeItem('spotify_code_verifier');
            this.saveTokens(data);
            await this.fetchProfile().catch((e) => { this.lastError = e.message; });
            return true;
        } catch (e) {
            console.error('Spotify Auth Error:', e);
            return false;
        }
    }

    saveTokens(data) {
        this.accessToken = data.access_token;
        if (data.refresh_token) this.refreshToken = data.refresh_token;
        if (data.expires_in) {
            this.expiresAt = Date.now() + (data.expires_in * 1000);
            localStorage.setItem('spotify_expires_at', this.expiresAt);
        }

        localStorage.setItem('spotify_access_token', this.accessToken);
        if (this.refreshToken) localStorage.setItem('spotify_refresh_token', this.refreshToken);
        // remember which permissions Spotify actually gave us, so we only ask to
        // reconnect when one is really missing (not on every "no" from Spotify)
        if (data.scope) localStorage.setItem('spotify_scope', data.scope);
    }

    // true / false when we know, null when this login is from before we saved it
    hasScope(name) {
        const s = localStorage.getItem('spotify_scope');
        if (!s) return null;
        return s.split(' ').includes(name);
    }

    // a fetch that refreshes the login once if Spotify says the token is old
    async _get(url) {
        let token = await this.getValidToken();
        if (!token) throw Object.assign(new Error('Not connected to Spotify'), { code: 'login' });
        let res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (res.status === 401 && await this.refreshAccessToken()) {
            res = await fetch(url, { headers: { 'Authorization': `Bearer ${this.accessToken}` } });
        }
        return res;
    }

    async refreshAccessToken() {
        if (!this.refreshToken) return false;

        try {
            const body = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: this.refreshToken,
                client_id: SPOTIFY_CONFIG.clientId
            });

            const res = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body
            });

            const data = await res.json();
            if (data.error || !data.access_token) {
                throw new Error(data.error_description || data.error || 'No access token returned');
            }
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
            if (!res.ok) throw new Error('Spotify profile said ' + res.status + ': ' + text.slice(0, 120));
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
        localStorage.removeItem('spotify_code_verifier');
        localStorage.removeItem('spotify_scope');
        this.accessToken = null;
        this.refreshToken = null;
        this.expiresAt = null;
        this.profile = null;
    }

    // Returns a logged-in user token, or null if the user isn't connected.
    // (The old "guest mode" needed the client secret, which can't live in the browser.)
    async getValidToken() {
        if (!this.accessToken) return null;

        if (this.expiresAt && Date.now() < Number(this.expiresAt) - 60000) {
            return this.accessToken;
        }

        const refreshed = await this.refreshAccessToken();
        if (refreshed) return this.accessToken;

        console.warn("Failed to refresh Spotify token, logging out");
        this.softLogout();
        return null;
    }

    isConnected() {
        return !!this.accessToken;
    }

    async getTracksFromPlaylist(url) {
        // Extract ID: https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoPBqM0
        const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
        const playlistId = match ? match[1] : url;

        const token = await this.getValidToken();
        if (!token) {
            // Not connected -> read the public embed page instead
            return await this.scrapeEmbedData(playlistId);
        }

        try {
            const pRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (pRes.status === 401) {
                console.warn("Spotify token rejected. Falling back to embed reader...");
                this.softLogout();
                return await this.scrapeEmbedData(playlistId);
            }

            let pData = null;
            try { pData = await pRes.json(); } catch (e) {}

            // Spotify renamed `tracks` to `items` in 2026 - accept both.
            // For playlists you don't own/collaborate on, Spotify now only sends
            // the title (no songs), so we fall back to the embed reader below.
            let page = null;
            if (pData) {
                if (Array.isArray(pData.items)) page = { items: pData.items };
                else page = pData.items || pData.tracks;
            }

            if (!pRes.ok || !page || !Array.isArray(page.items)) {
                console.warn("Spotify API gave no song list for this playlist. Falling back to embed reader.");
                return await this.scrapeEmbedData(playlistId);
            }

            const title = pData.name;
            const tracksData = page.items.map(entry => {
                const track = entry && (entry.track || entry.item);
                if (!track) return null;
                return {
                    name: `${track.artists?.[0]?.name || 'Unknown Artist'} - ${track.name}`,
                    url: track.external_urls?.spotify || "",
                    id: track.id
                };
            }).filter(Boolean);

            if (tracksData.length === 0) {
                return await this.scrapeEmbedData(playlistId);
            }

            return { title: title, tracks: tracksData };
        } catch (e) {
            console.warn("Spotify standard fetch blocked/failed. Attempting embed fallback.", e);
            return await this.scrapeEmbedData(playlistId);
        }
    }

    // ---- v3: used by "Add Songs" -------------------------------------------------
    // Every page of a Spotify list endpoint. Throws {code:'scope'} when the login is
    // from before v3 (missing the new permissions) so the UI can ask to reconnect.
    async _allPages(url, max = 2000, needScope = 'playlist-read-private') {
        const out = [];
        while (url && out.length < max) {
            const res = await this._get(url);
            if (res.status === 401 || res.status === 403) {
                let why = '';
                try { const j = await res.json(); why = (j.error && (j.error.message || j.error)) || ''; } catch (e) {}
                console.warn('Spotify said', res.status, why);
                const missing = this.hasScope(needScope) === false || /scope/i.test(why);
                // only a missing permission can be fixed by connecting again
                if (missing) throw Object.assign(new Error('Spotify needs you to reconnect (new permissions).'), { code: 'scope' });
                throw Object.assign(new Error(why || ('Spotify said ' + res.status)), { code: 'denied', status: res.status, why });
            }
            if (res.status === 429) throw new Error('Spotify says slow down, try again in a minute');
            if (!res.ok) throw new Error('Spotify said ' + res.status);
            const data = await res.json();
            out.push(...(data.items || []));
            url = data.next;
        }
        return out;
    }

    _normTrack(entry) {
        const t = entry && (entry.track || entry.item || entry);
        if (!t || !t.name || t.type === 'episode') return null;
        return {
            title: t.name,
            artist: (t.artists || []).map(a => a.name).join(', '),
            duration: Math.round((t.duration_ms || 0) / 1000),
            spotify: t.id || '',
            art: t.album && t.album.images && t.album.images.length ? t.album.images[t.album.images.length > 1 ? 1 : 0].url : ''
        };
    }

    async getMyPlaylists() {
        const items = await this._allPages('https://api.spotify.com/v1/me/playlists?limit=50', 500);
        return items.filter(Boolean).map(p => ({
            id: p.id,
            name: p.name,
            count: (p.tracks && p.tracks.total) || (p.items && p.items.total) || 0,
            image: p.images && p.images.length ? p.images[p.images.length - 1].url : ''
        }));
    }

    async getLikedSongs() {
        const items = await this._allPages('https://api.spotify.com/v1/me/tracks?limit=50', 2000, 'user-library-read');
        return { title: 'Liked Songs', tracks: items.map(e => this._normTrack(e)).filter(Boolean) };
    }

    async getPlaylistFull(id) {
        const token = await this.getValidToken();
        if (!token) throw Object.assign(new Error('Not connected to Spotify'), { code: 'login' });
        const meta = await fetch(`https://api.spotify.com/v1/playlists/${id}?fields=name,images`, { headers: { 'Authorization': `Bearer ${token}` } })
            .then(r => r.ok ? r.json() : {}).catch(() => ({}));
        let items;
        try {
            // Spotify renamed /tracks to /items in 2026; try the new one first
            items = await this._allPages(`https://api.spotify.com/v1/playlists/${id}/items?limit=100`);
        } catch (e) {
            if (e.code === 'scope') throw e;
            items = await this._allPages(`https://api.spotify.com/v1/playlists/${id}/tracks?limit=100`);
        }
        const tracks = items.map(e => this._normTrack(e)).filter(Boolean);
        return { title: meta.name || 'Spotify playlist', image: meta.images && meta.images[0] ? meta.images[0].url : '', tracks };
    }

    async scrapeEmbedData(playlistId) {
        try {
            // Determine the API backend dynamically just like app.js
            const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
                ? "http://localhost:3000"
                : "https://okfait-github-io.vercel.app";

            // Target the robust, shallow Vercel proxy endpoint using a query parameter to avoid Vercel nested path slicing bugs
            const embedUrl = `https://open.spotify.com/embed/playlist/${playlistId}`;
            const res = await fetch(`${API_BASE}/api/proxy?url=${encodeURIComponent(embedUrl)}`);
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
