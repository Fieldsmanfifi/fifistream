/* This file is PUBLIC on GitHub Pages. Never put passwords or API secrets here.
   The sender loads this same file, so both ends use the same signaling service.
   {} selects the free public PeerJS Cloud service.
   A private PeerServer can use {host: "signal.example.com", port: 443,
   path: "/peerjs", secure: true, key: "peerjs"}.
   Optional TURN credentials are entered into the app/page, never committed here. */
window.FIFI_CONFIG = Object.freeze({
  signaling: {},
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ]
});
