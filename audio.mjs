let hlsLibrary = null;
export function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLibrary) hlsLibrary = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js';
    script.integrity = 'sha384-cciJ0zi8d1uMKC2zJd7jvPY4HQt7W4ByUI/FlMkltvBi31aW61rcpVBhpmW8/NwX';
    script.crossOrigin = 'anonymous';
    script.onload = () => window.Hls ? resolve(window.Hls) : reject(Error('재생기 로드 실패'));
    script.onerror = () => { script.remove(); reject(Error('오디오 재생기 로드 실패 · 인터넷 연결 확인')); };
    document.head.append(script);
  }).catch(error => { hlsLibrary = null; throw error; });
  return hlsLibrary;
}

// All media requests go from the client to the original broadcast, never through our server.
export function initAudio($, { beforePlay = () => {} } = {}) {
  const audio = $('broadcast-audio');
  let player = null, ready = false, warming = false, wanted = false, attempt = 0, preparedSource = '', sourceVersion = 0;
  let enabled = false, reloadManifest = false, released = false;
  let available = Boolean($('audio-url').value.trim());
  // Playback belongs to this visit; discard the preference saved by older versions.
  try { window.localStorage?.removeItem('assembly-caption-audio-enabled'); } catch {}
  audio.pause();
  function updateToggle() {
    $('audio-toggle').checked = enabled && available;
    $('audio-toggle').disabled = !available || warming;
  }
  function ui(message) {
    updateToggle();
    $('audio-status').textContent = message;
  }
  function mediaState(state) {
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = state; } catch {} }
  }
  function stopLoading() {
    if (!player) return;
    // stopLoad aborts an in-flight initial manifest; startLoad alone cannot restart it.
    if (!player.levels.length) reloadManifest = true;
    player.stopLoad();
  }
  function stopPlayback(message = '오디오 일시정지') {
    attempt++; wanted = false; audio.pause(); stopLoading(); ui(message); mediaState('paused');
  }
  function turnOff(message = '오디오 일시정지') {
    enabled = false; stopPlayback(message);
  }
  function turnOn() {
    if (!available) { updateToggle(); return; }
    beforePlay();
    released = false;
    enabled = true; ui(ready ? '오디오 연결 중' : '오디오 재생 준비 중'); return play();
  }


  async function warm() {
    if (warming) return;
    const version = sourceVersion;
    warming = true; ready = false; $('audio-toggle').disabled = true;
    ui('오디오 재생기 준비 중');
    try {
      if (!$('audio-url').value.trim()) { ui('방송 채널을 선택하세요.'); return; }
      const source = new URL($('audio-url').value.trim());
      if (source.protocol !== 'https:') throw Error('오디오 주소는 HTTPS 주소를 입력하세요.');
      player?.destroy(); player = null; reloadManifest = false; audio.removeAttribute('src'); audio.load();
      const native = audio.canPlayType('application/vnd.apple.mpegurl') || audio.canPlayType('application/x-mpegURL');
      const safari = /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Android/.test(navigator.userAgent);
      if (safari && native) {
        audio.src = source.href;
      } else {
        // Android Edge may claim native HLS support but fail at playback; use MSE when available.
        const Hls = window.Hls || await loadHls();
        if (version !== sourceVersion) return;
        if (Hls.isSupported()) {
          const current = new Hls({ autoStartLoad: false, maxBufferLength: 30, backBufferLength: 10, liveSyncDurationCount: 3 });
          player = current;
          current.on(Hls.Events.ERROR, (_event, data) => {
            if (player !== current || !data.fatal) return;
            ready = false;
            turnOff(data.type === 'networkError' ? '방송 연결 실패 · 중계 중인지 확인하세요.' : '방송 음성 재생 실패 · 다시 시도하세요.');
            current.destroy(); player = null;
          });
          current.attachMedia(audio); current.loadSource(source.href);
        } else if (native) audio.src = source.href;
        else throw Error('이 브라우저는 방송 오디오 재생을 지원하지 않습니다.');
      }
      if (version !== sourceVersion) return;
      preparedSource = source.href; ready = true; ui(enabled ? '오디오 연결 중' : '오디오 대기');
    } catch (error) { if (version === sourceVersion) ui(error.message); }
    finally {
      warming = false; updateToggle();
      if (version !== sourceVersion && !released && $('audio-url').value.trim()) warm();
      else if (enabled && ready) play();
    }
  }

  function setSource(value, unavailableMessage = '현재 방송 중인 채널을 선택하세요.') {
    const next = value?.trim() || '';
    const wasAvailable = available;
    available = Boolean(next);
    if (!next) {
      if (wasAvailable || player || warming || enabled) reset();
      $('audio-url').value = '';
      ui(unavailableMessage); return;
    }
    if (preparedSource === next && ready) return;
    stopPlayback(next ? '오디오 채널 변경 중' : '방송 채널을 선택하세요.');
    sourceVersion++; preparedSource = ''; ready = false; $('audio-url').value = next;
    released = false;
    if (next) warm();
  }

  function reset() {
    released = true; turnOff(); sourceVersion++;
    preparedSource = ''; ready = false; reloadManifest = false;
    const previous = player; player = null; previous?.destroy();
    audio.removeAttribute('src'); audio.load();
  }

  async function play() {
    if (!enabled || wanted || warming) return;
    if (!ready) { await warm(); if (!ready || !enabled || wanted) return; }
    beforePlay();
    const token = ++attempt; wanted = true; ui('오디오 연결 중');
    try {
      if (player && reloadManifest) {
        reloadManifest = false;
        player.loadSource(preparedSource);
      }
      player?.startLoad();
      if (audio.seekable.length) {
        const last = audio.seekable.length - 1;
        audio.currentTime = Math.max(audio.seekable.start(last), audio.seekable.end(last) - 2);
      }
      if ('audioSession' in navigator) { try { navigator.audioSession.type = 'playback'; } catch {} }
      if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
        try { navigator.mediaSession.metadata = new MediaMetadata({ title: '국회 중계 오디오', artist: '대한민국 국회' }); } catch {}
      }
      // The normal path calls play() directly inside the switch gesture, before awaiting anything.
      await audio.play();
      if (token === attempt && wanted) { ui('오디오 재생 중'); mediaState('playing'); }
    } catch (error) {
      if (token !== attempt) return;
      // Keep the switch off after a failed attempt; retry requires another play action.
      wanted = false; enabled = false; stopLoading(); mediaState('paused');
      if (error.name !== 'NotAllowedError') ready = false;
      ui(error.name === 'NotAllowedError' ? '자동 재생 차단됨 · 오디오 스위치를 켜세요.' : '오디오 재생 실패 · 다시 시도하세요.');
    }
  }

  $('audio-toggle').onchange = () => $('audio-toggle').checked ? turnOn() : turnOff();
  $('audio-url').onchange = () => setSource($('audio-url').value);
  audio.addEventListener('playing', () => {
    if (!wanted) { audio.pause(); return; }
    ui('오디오 재생 중'); mediaState('playing');
  });
  audio.addEventListener('pause', () => {
    if (warming || !audio.paused || !wanted) return;
    enabled = false; attempt++; wanted = false; stopLoading(); ui('오디오 일시정지'); mediaState('paused');
  });
  audio.addEventListener('waiting', () => { if (wanted) ui('오디오 버퍼링 중'); });
  audio.addEventListener('ended', () => turnOff('방송 오디오 종료'));
  audio.addEventListener('error', () => { if (audio.error && !warming) { ready = false; turnOff('오디오 연결 실패 · 다시 시도하세요.'); } });
  if ('mediaSession' in navigator) {
    for (const [action, handler] of [['play', turnOn], ['pause', () => turnOff()], ['stop', () => turnOff()]]) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch {}
    }
  }
  if ($('audio-url').value.trim()) warm(); else ui('방송 채널을 선택하세요.');
  return { play: turnOn, pause: turnOff, reset, setSource,
    suspend() { enabled = false; stopPlayback(); },
  };
}
