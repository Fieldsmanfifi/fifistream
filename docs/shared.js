(function (root) {
  'use strict';
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const PROTOCOL = 1;

  function createSession(cryptoObject = root.crypto) {
    const bytes = cryptoObject.getRandomValues(new Uint8Array(16));
    let buffer = 0, bits = 0, encoded = '';
    for (const byte of bytes) {
      buffer = (buffer << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        encoded += ALPHABET[(buffer >>> bits) & 31];
      }
    }
    if (bits) encoded += ALPHABET[(buffer << (5 - bits)) & 31];
    return encoded;
  }

  function normalizeSession(input) {
    if (typeof input !== 'string') throw new Error('Paste the session ID from the sender.');
    const token = input.trim().toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(token) || !/[048CGMRW]$/.test(token)) {
      throw new Error('That session ID is incomplete. Copy the whole ID from the sender.');
    }
    return token;
  }

  function formatSession(token) {
    return normalizeSession(token).match(/.{1,5}/g).join('-');
  }

  async function peerId(token, cryptoObject = root.crypto) {
    const digest = await cryptoObject.subtle.digest('SHA-256', new TextEncoder().encode(normalizeSession(token)));
    return 'fifi-v1-' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  function sameToken(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
  }

  function parseRelay(urls, username, credential, relayOnly = false) {
    const list = String(urls || '').split(/[\s,]+/).filter(Boolean);
    if (!list.length) {
      if (relayOnly) throw new Error('Enter a TURN relay address before selecting relay only.');
      return { servers: [], policy: 'all' };
    }
    if (list.length > 6 || list.some(url => !/^turns?:[a-z0-9.\[\]:-]+(?::\d+)?(?:\?transport=(?:udp|tcp))?$/i.test(url))) {
      throw new Error('Use a TURN address such as turn:relay.example.com:3478.');
    }
    if (!username || !credential) throw new Error('Enter the TURN username and password.');
    if (username.length > 512 || credential.length > 1024) throw new Error('The TURN credentials are too long.');
    return { servers: [{ urls: list, username, credential }], policy: relayOnly ? 'relay' : 'all' };
  }

  function peerOptions(config, relay) {
    return {
      ...config.signaling,
      debug: 0,
      config: {
        iceServers: [...config.iceServers, ...relay.servers],
        iceTransportPolicy: relay.policy
      }
    };
  }

  function viewerLink(base, token) {
    let url;
    try { url = new URL(base); } catch { throw new Error('Enter the full HTTPS address of your viewer page.'); }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('The viewer page needs an HTTPS address.');
    }
    url.hash = new URLSearchParams({ s: normalizeSession(token) }).toString();
    return url.href;
  }

  function sessionFromHash(hash) {
    const raw = new URLSearchParams(String(hash).replace(/^#/, '')).get('s');
    return raw ? normalizeSession(raw) : '';
  }

  // Prefer H.264 and its retransmission codecs without removing fallback codecs.
  function preferH264(sdp) {
    const separator = sdp.includes('\r\n') ? '\r\n' : '\n';
    const lines = sdp.split(separator);
    const start = lines.findIndex(line => line.startsWith('m=video '));
    if (start < 0) return sdp;
    let end = lines.findIndex((line, i) => i > start && line.startsWith('m='));
    if (end < 0) end = lines.length;
    const section = lines.slice(start, end);
    const h264 = section.flatMap(line => {
      const match = /^a=rtpmap:(\d+) H264\/90000/i.exec(line);
      return match ? [match[1]] : [];
    });
    if (!h264.length) return sdp;
    const fields = lines[start].split(' '), payloads = fields.slice(3);
    const preferred = [];
    for (const id of h264) {
      if (payloads.includes(id)) preferred.push(id);
      for (const line of section) {
        const match = /^a=fmtp:(\d+) .*\bapt=(\d+)(?:;|$)/.exec(line);
        if (match && match[2] === id && payloads.includes(match[1])) preferred.push(match[1]);
      }
    }
    lines[start] = [...fields.slice(0, 3), ...new Set([...preferred, ...payloads])].join(' ');
    return lines.join(separator);
  }

  function friendlyError(error) {
    const type = error && error.type;
    if (type === 'peer-unavailable') return 'This session is not online. Check the ID and ask Fifi to start the stream.';
    if (type === 'unavailable-id') return 'The session could not be registered. Stop and start again for a new ID.';
    if (['network', 'socket-error', 'server-error', 'socket-closed'].includes(type)) {
      return 'The session service is unavailable. Check your internet connection and try again.';
    }
    if (['browser-incompatible', 'ssl-unavailable'].includes(type)) return 'Open the HTTPS viewer page in an up-to-date Safari browser.';
    return error && error.message ? error.message : 'The connection failed. Please try again.';
  }

  const api = { PROTOCOL, createSession, normalizeSession, formatSession, peerId, sameToken,
    parseRelay, peerOptions, viewerLink, sessionFromHash, preferH264, friendlyError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FifiShared = Object.freeze(api);
})(globalThis);
