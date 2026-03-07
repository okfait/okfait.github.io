import { SPOTIFY_CONFIG } from './spotify-config.js';

export class SpotifyManager {
    constructor() {
        this.accessToken = localStorage.getItem('spotify_access_token');
        this.refreshToken = localStorage.getItem('spotify_refresh_token');
        this.expiresAt = localStorage.getItem('spotify_expires_at');
        this.profile = JSON.parse(localStorage.getItem('spotify_profile'));
    }

    login() {
        const params = new URLSearchParams({
            client_id: SPOTIFY_CONFIG.clientId,
            response_type: 'code',
            redirect_uri: SPOTIFY_CONFIG.redirectUri,
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
        localStorage.removeItem('spotify_access_token');
        localStorage.removeItem('spotify_refresh_token');
        localStorage.removeItem('spotify_expires_at');
        localStorage.removeItem('spotify_profile');
        this.accessToken = null;
        this.refreshToken = null;
        this.expiresAt = null;
        this.profile = null;
        window.location.reload();
    }

    async getValidToken() {
        // If we have a user token, use it
        if (this.accessToken && !this.isGuest) {
            if (Date.now() > this.expiresAt - 60000) {
                await this.refreshAccessToken();
            }
            return this.accessToken;
        }
        // Otherwise, use guest mode
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
            // First get playlist title
            const pRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const pText = await pRes.text();
            let pData;
            try {
                pData = JSON.parse(pText);
            } catch (e) {
                throw new Error("Playlist Info Error: " + pText.slice(0, 100));
            }

            if (!pRes.ok) throw new Error(pData.error?.message || pData.error || "Failed to fetch playlist info");

            const title = pData.name;
            
            // Then get tracks
            const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            const text = await res.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                throw new Error("Track Parse Error: " + text.slice(0, 100));
            }

            if (!res.ok) throw new Error(data.error?.message || data.error || "Failed to fetch tracks");

            return {
                title: title,
                tracks: data.items.map(item => ({
                    name: `${item.track.artists[0].name} - ${item.track.name}`,
                    url: item.track.external_urls.spotify,
                    id: item.track.id
                }))
            };
        } catch (e) {
            console.error("Spotify Fetch Error:", e);
            throw e;
        }
    }
}
