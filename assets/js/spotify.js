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
        this.expiresAt = Date.now() + (data.expires_in * 1000);

        localStorage.setItem('spotify_access_token', this.accessToken);
        if (this.refreshToken) localStorage.setItem('spotify_refresh_token', this.refreshToken);
        localStorage.setItem('spotify_expires_at', this.expiresAt);
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

            if (res.status === 401) {
                if (await this.refreshAccessToken()) return this.fetchProfile();
                return;
            }

            this.profile = await res.json();
            localStorage.setItem('spotify_profile', JSON.stringify(this.profile));
            return this.profile;
        } catch (e) {
            console.error('Spotify Profile Error:', e);
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
        if (Date.now() > this.expiresAt - 60000) {
            await this.refreshAccessToken();
        }
        return this.accessToken;
    }

    isConnected() {
        return !!this.accessToken;
    }
}
