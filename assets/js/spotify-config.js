// NOTE: no client secret here on purpose. This file is public.
// Login uses the secret-free (PKCE) flow, so only the Client ID is needed.
export const SPOTIFY_CONFIG = {
    clientId: '2ac7cd7c780548adbc488b444319520e',
    redirectUri: window.location.origin.replace(/\/$/, '').trim(),
    scopes: [
        'user-read-private',
        'user-read-email',
        'user-read-playback-state',
        'user-modify-playback-state',
        'user-read-currently-playing',
        'streaming',
        // v3: lets "Add Songs" show your own playlists (private ones too) and Liked Songs
        'playlist-read-private',
        'playlist-read-collaborative',
        'user-library-read'
    ]
};
