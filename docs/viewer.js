(function () {
  'use strict';
  const S = window.FifiShared;
  const $ = id => document.getElementById(id);
  const video = $('video');
  let peer = null, connection = null, call = null, expectedHost = '', generation = 0;
  let joining = false, hasStream = false, handshakeTimer, mediaTimer, disconnectTimer, wakeLock = null, wakePending = false;

  function joinStatus(message, state = '') { $('join-message').textContent = message; $('join-status').dataset.state = state; }
  function playerStatus(message, state = '') { $('player-message').textContent = message; $('player-status').dataset.state = state; }
  function setJoining(value) {
    joining = value; $('join').disabled = value; $('session').disabled = value;
    ['relay-urls', 'relay-user', 'relay-pass', 'relay-only'].forEach(id => { $(id).disabled = value; });
  }
  async function keepAwake() {
    if (!hasStream || document.visibilityState !== 'visible' || !navigator.wakeLock || wakeLock || wakePending) return;
    const epoch = generation;
    wakePending = true;
    try {
      const acquired = await navigator.wakeLock.request('screen');
      if (epoch !== generation || !hasStream || document.visibilityState !== 'visible') { await acquired.release(); return; }
      wakeLock = acquired;
      acquired.addEventListener('release', () => { if (wakeLock === acquired) wakeLock = null; });
    } catch {} finally { wakePending = false; }
  }
  function cleanup(message = 'You left the stream.', state = '') {
    generation++;
    clearTimeout(handshakeTimer); clearTimeout(mediaTimer); clearTimeout(disconnectTimer);
    hasStream = false;
    const oldCall = call, oldConnection = connection, oldPeer = peer;
    call = null; connection = null; peer = null; expectedHost = '';
    if (oldCall) oldCall.close();
    if (oldConnection) oldConnection.close();
    if (oldPeer) oldPeer.destroy();
    video.pause(); video.srcObject = null; video.muted = true;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    $('player-card').hidden = true; $('join-card').hidden = false;
    $('play-overlay').hidden = false; $('play').disabled = true; $('play').textContent = 'Waiting for the stream…';
    $('play-help').textContent = 'The picture and sound will arrive here.';
    $('live-badge').textContent = 'Connecting';
    setJoining(false); joinStatus(message, state);
  }

  function watchIncoming(incoming, epoch) {
    if (epoch !== generation || incoming.peer !== expectedHost || !connection?.open || call || incoming.metadata?.kind !== 'fifi-stream' || incoming.metadata?.protocol !== S.PROTOCOL) {
      incoming.close(); return;
    }
    call = incoming;
    $('player-card').hidden = false; $('join-card').hidden = true;
    playerStatus('Connecting to the stream…');
    incoming.on('stream', stream => {
      if (epoch !== generation) return;
      clearTimeout(handshakeTimer); clearTimeout(mediaTimer);
      hasStream = true; video.srcObject = stream; video.muted = true;
      video.play().catch(() => {});
      $('play-overlay').hidden = false; $('play').disabled = false; $('play').textContent = 'Play with sound';
      $('play-help').textContent = 'Tap once to start playback and enable audio.';
      $('live-badge').textContent = 'Live';
      playerStatus('Connected. Tap Play with sound.', 'live');
      stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
        if (epoch === generation) cleanup('Fifi stopped the stream. Ask for the new ID when he starts again.');
      }));
      keepAwake();
    });
    incoming.on('close', () => { if (epoch === generation) cleanup('The stream ended or disconnected. You can rejoin if Fifi is still streaming.'); });
    incoming.on('error', () => { if (epoch === generation) cleanup('The media connection failed. Try again, or use a TURN relay on both devices.', 'error'); });
    try { incoming.answer(undefined, { sdpTransform: S.preferH264 }); }
    catch (error) { cleanup(S.friendlyError(error), 'error'); return; }
    const pc = incoming.peerConnection;
    if (pc) pc.addEventListener('iceconnectionstatechange', () => {
      if (epoch !== generation) return;
      const state = pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') clearTimeout(disconnectTimer);
      else if (state === 'failed' || state === 'closed') cleanup('The stream connection dropped. Try rejoining or use a TURN relay on both devices.', 'error');
      else if (state === 'disconnected') {
        clearTimeout(disconnectTimer); playerStatus('Connection interrupted. Waiting for it to recover…');
        disconnectTimer = setTimeout(() => { if (epoch === generation) cleanup('The connection was lost. Rejoin to try again.', 'error'); }, 15000);
      }
    });
    mediaTimer = setTimeout(() => {
      if (epoch === generation && !hasStream) cleanup('The stream could not connect. Try a TURN relay in the connection settings on both devices.', 'error');
    }, 35000);
  }

  async function join(event) {
    event.preventDefault();
    if (joining) return;
    let token, relay;
    try {
      if (!window.Peer) throw new Error('The connection library is missing. Ask Fifi to upload the complete docs folder.');
      if (!window.isSecureContext || !window.RTCPeerConnection) throw new Error('Open this page over HTTPS in an up-to-date Safari browser.');
      token = S.normalizeSession($('session').value);
      relay = S.parseRelay($('relay-urls').value, $('relay-user').value, $('relay-pass').value, $('relay-only').checked);
    } catch (error) { joinStatus(error.message, 'error'); return; }
    const epoch = ++generation;
    setJoining(true); joinStatus('Finding Fifi’s stream…');
    try {
      expectedHost = await S.peerId(token);
      if (epoch !== generation) return;
      const currentPeer = new Peer(S.peerOptions(window.FIFI_CONFIG, relay));
      peer = currentPeer;
      handshakeTimer = setTimeout(() => {
        if (epoch === generation && !hasStream) cleanup('Could not reach the stream. Check the session ID, or try a TURN relay on both devices.', 'error');
      }, 35000);
      currentPeer.on('open', () => {
        if (epoch !== generation) return;
        const currentConnection = currentPeer.connect(expectedHost, { label: 'fifi-watch-v1', reliable: true, serialization: 'json' });
        connection = currentConnection;
        currentConnection.on('open', () => {
          if (epoch !== generation) return;
          // The session secret is sent only through the encrypted WebRTC data channel,
          // never in PeerServer metadata, the peer ID, or the website URL query.
          currentConnection.send({ type: 'join', protocol: S.PROTOCOL, token });
          joinStatus('Connected to the sender. Waiting for video…');
        });
        currentConnection.on('data', data => {
          if (epoch !== generation || !data || typeof data !== 'object') return;
          if (data.type === 'accepted') joinStatus('Starting the video…');
          else if (['busy', 'rejected', 'failed'].includes(data.type)) cleanup(data.message || 'The sender could not accept this viewer.', 'error');
          else if (data.type === 'ended') cleanup('Fifi stopped the stream. The session ID has expired.');
        });
        currentConnection.on('close', () => { if (epoch === generation) cleanup('The sender disconnected. You can rejoin if the stream is still running.'); });
        currentConnection.on('error', () => { if (epoch === generation) cleanup('The connection failed. Try a TURN relay on both devices.', 'error'); });
      });
      currentPeer.on('call', incoming => watchIncoming(incoming, epoch));
      currentPeer.on('connection', unexpected => unexpected.close());
      currentPeer.on('error', error => { if (epoch === generation) cleanup(S.friendlyError(error), 'error'); });
      currentPeer.on('disconnected', () => {
        if (epoch !== generation) return;
        if (!hasStream) cleanup('The session service disconnected. Try joining again.', 'error');
        // An established peer-to-peer stream does not need the signaling socket.
      });
    } catch (error) { if (epoch === generation) cleanup(S.friendlyError(error), 'error'); }
  }

  $('join-form').addEventListener('submit', join);
  $('leave').addEventListener('click', () => cleanup());
  $('play').addEventListener('click', async () => {
    if (!hasStream) return;
    const epoch = generation;
    video.muted = false;
    try {
      await video.play();
      if (epoch !== generation) return;
      $('play-overlay').hidden = true;
      playerStatus('Watching together.', 'live'); keepAwake();
    } catch {
      if (epoch !== generation) return;
      video.muted = true; $('play-help').textContent = 'Safari paused playback. Tap again to play, and check your phone volume.';
    }
  });
  $('fullscreen').addEventListener('click', async () => {
    try {
      if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else if (video.requestFullscreen) await video.requestFullscreen();
      else playerStatus('Turn your phone sideways for a larger picture.', 'live');
    } catch { playerStatus('Try the full-screen button in the video controls.', 'live'); }
  });
  document.addEventListener('visibilitychange', () => {
    if (hasStream && document.visibilityState === 'visible') {
      keepAwake();
      if (video.paused) {
        $('play-overlay').hidden = false; $('play').textContent = 'Resume with sound';
        playerStatus('Tap to resume playback.', 'live');
      }
    }
  });
  window.addEventListener('pagehide', () => cleanup());
  try {
    const saved = S.sessionFromHash(window.location.hash);
    if (saved) { $('session').value = S.formatSession(saved); joinStatus('Your session ID is filled in. Tap Join stream.'); }
  } catch (error) { joinStatus(error.message, 'error'); }
})();
