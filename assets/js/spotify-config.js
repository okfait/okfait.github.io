export const SPOTIFY_CONFIG = {
    clientId: '2ac7cd7c780548adbc488b444319520e',
    clientSecret: '197c79af7b974b718cb141a37aa3215c',
    redirectUri: window.location.origin.replace(/\/$/, '').trim(),
    scopes: [
        'user-read-private',
        'user-read-email',
        'user-read-playback-state',
        'user-modify-playback-state',
        'user-read-currently-playing',
        'streaming'
    ]
};
