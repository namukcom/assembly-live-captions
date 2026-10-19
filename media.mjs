import { initAudio, loadHls } from './audio.mjs';

export function initMedia($, { onLayout = () => {} } = {}) {
  const video = $('broadcast-video'), shell = $('media-shell'), panel = $('media-panel');
  let channel = null, sourceKey = '', player = null, prepared = '', preparing = null;
  let version = 0, preparingVersion = -1, attempt = 0, wanted = false, reloadManifest = false;
  let quality = 'auto', expanded = false, chromeTimer = null, captionKey = '';
  let released = false, orientationManaged = false, orientationAttempt = 0;
  let pipActive = false, reloadAfterPip = false;
  const audio = initAudio($, { beforePlay: () => stopVideo() });

  function status(message) { $('media-status').textContent = message; }
  function isFullscreen() { return document.fullscreenElement === shell || document.webkitFullscreenElement === shell; }
  function inPip() { return document.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture'; }
  function supportedPip() {
    return Boolean((document.pictureInPictureEnabled && video.requestPictureInPicture) ||
      video.webkitSupportsPresentationMode?.('picture-in-picture'));
  }
  function updateControls() {
    const active = !panel.hidden;
    $('video-toggle').checked = active && wanted;
    $('video-options').hidden = !(active && wanted);
    $('video-toggle').disabled = !channel;
    $('video-quality').disabled = !channel;
    $('pip-toggle').disabled = !active || video.readyState < 2 || !supportedPip();
    $('pip-toggle').setAttribute('aria-pressed', String(inPip()));
    $('pip-toggle').title = supportedPip() ? '작은 창으로 영상 보기 (자막 제외)' : '이 브라우저는 PIP를 지원하지 않습니다';
    $('fullscreen-toggle').disabled = !active;
    $('fullscreen-toggle').setAttribute('aria-pressed', String(expanded));
    $('fullscreen-toggle').textContent = expanded ? '전체화면 종료' : '전체화면';
    $('fullscreen-play').textContent = video.paused ? '재생' : '일시정지';
    $('fullscreen-play').setAttribute('aria-label', video.paused ? '영상 재생' : '영상 일시정지');
  }
  function mediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = video.paused ? 'paused' : 'playing';
      if (typeof MediaMetadata !== 'undefined') navigator.mediaSession.metadata = new MediaMetadata({
        title: channel?.name || '국회 생중계', artist: '대한민국 국회',
      });
    } catch {}
  }
  function stopLoading() {
    if (!player) return;
    if (!player.levels.length) reloadManifest = true;
    player.stopLoad();
  }
  function exitPip() {
    if (document.pictureInPictureElement === video) return document.exitPictureInPicture().catch(() => {});
    if (video.webkitPresentationMode === 'picture-in-picture') {
      try { video.webkitSetPresentationMode('inline'); } catch {}
    }
    return Promise.resolve();
  }
  function pipChanged() {
    const active = inPip();
    // A browser can close PIP when another tab takes over media playback.
    // Reattach the video on the next play instead of reusing its old output.
    if (pipActive && !active) reloadAfterPip = true;
    pipActive = active;
    updateControls(); onLayout();
  }
  function fullscreenChanged() {
    expanded = isFullscreen() || shell.classList.contains('is-expanded');
    document.body.classList.toggle('media-expanded', expanded);
    if (!expanded) {
      releaseOrientation();
      window.clearTimeout(chromeTimer); shell.classList.remove('controls-hidden');
    } else revealControls();
    updateControls(); onLayout();
  }
  async function exitFullscreen() {
    releaseOrientation();
    shell.classList.remove('is-expanded');
    if (isFullscreen()) {
      try {
        await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen());
      } catch {}
    }
    fullscreenChanged();
  }
  function resetVideoConnection() {
    version++;
    video.pause();
    const previous = player; player = null; previous?.destroy();
    prepared = ''; reloadManifest = false; reloadAfterPip = false;
    video.removeAttribute('src'); video.load();
  }
  function stopVideo() {
    attempt++; wanted = false; released = true; panel.hidden = true; pipActive = false;
    resetVideoConnection();
    exitPip(); exitFullscreen();
    status('영상 정지'); updateControls(); onLayout();
  }
  function failure(message) {
    wanted = false; attempt++; video.pause(); stopLoading(); status(message); updateControls();
  }
  function manifestUrl() { return `/api/video.m3u8?channel=${encodeURIComponent(channel.id)}`; }
  function nativeUrl() {
    return quality === 'auto' ? manifestUrl() : channel.videoSources?.find(source => String(source.height) === quality)?.url || manifestUrl();
  }
  function showQuality(height) {
    const suffix = height ? `${height}p` : player ? '화질 확인 중' : '브라우저 선택';
    const label = quality === 'auto' ? `자동 · ${suffix}` : `${quality}p`;
    for (const id of ['video-quality', 'fullscreen-quality']) {
      const select = $(id);
      const auto = select.querySelector('option[value="auto"]');
      if (auto) auto.textContent = quality === 'auto' ? label : '자동';
      select.value = quality;
    }
  }
  function populateQuality(heights) {
    const values = [...new Set(heights.filter(Boolean))].sort((a, b) => a - b);
    if (quality !== 'auto' && !values.includes(Number(quality))) quality = 'auto';
    for (const id of ['video-quality', 'fullscreen-quality']) {
      const options = ['auto', ...values.map(String)].map(value => {
        const option = document.createElement('option'); option.value = value;
        option.textContent = value === 'auto' ? '자동' : `${value}p`; return option;
      });
      $(id).replaceChildren(...options); $(id).value = quality;
    }
  }
  function applyQuality() {
    if (player) {
      const level = quality === 'auto' ? -1 : player.levels.findIndex(level => level.height === Number(quality));
      // Keep buffered playback; the requested quality is used for subsequent downloads.
      player.loadLevel = level;
    } else if (prepared && channel) {
      const resume = wanted;
      attempt++; video.pause(); video.src = nativeUrl(); video.load();
      if (resume) playVideo();
    }
    showQuality(player?.levels[player.currentLevel]?.height || 0);
  }
  function prepare() {
    if (!channel || released || prepared === sourceKey) return Promise.resolve();
    if (preparing) return preparingVersion === version ? preparing : preparing.then(() => prepare());
    const token = version, key = sourceKey;
    preparingVersion = token;
    const task = (async () => {
      try {
        const native = video.canPlayType('application/vnd.apple.mpegurl');
        const safari = /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Android/.test(navigator.userAgent);
        if (safari && native) {
          video.src = nativeUrl();
        } else {
          const Hls = window.Hls || await loadHls();
          if (token !== version) return;
          if (Hls.isSupported()) {
            const current = new Hls({ autoStartLoad: false, startLevel: 0, testBandwidth: false,
              maxBufferLength: 15, backBufferLength: 10, liveSyncDurationCount: 3,
              abrBandWidthUpFactor: 0.65, capLevelOnFPSDrop: true });
            player = current;
            current.on(Hls.Events.MANIFEST_PARSED, () => {
              if (current !== player) return;
              populateQuality(current.levels.map(level => level.height));
              if (quality !== 'auto') applyQuality();
            });
            current.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
              if (current === player) showQuality(current.levels[data.level]?.height);
            });
            current.on(Hls.Events.ERROR, (_event, data) => {
              if (current !== player || !data.fatal) return;
              failure('영상 연결 실패 · 영상 재생을 다시 누르세요.');
              current.destroy(); player = null; prepared = '';
            });
            current.attachMedia(video); current.loadSource(manifestUrl());
          } else if (native) video.src = nativeUrl();
          else throw Error('이 브라우저는 영상 재생을 지원하지 않습니다.');
        }
        if (token !== version) return;
        prepared = key;
      } catch (error) { if (token === version) status(error.message); }
    })();
    // Cleanup must run after assignment even when native HLS prepares synchronously.
    const job = task.finally(() => {
      if (preparing === job) preparing = null;
      if (token !== version && channel && !released) prepare();
    });
    preparing = job;
    return job;
  }
  async function playVideo() {
    if (!channel) return;
    if (reloadAfterPip) {
      wanted = false; attempt++; resetVideoConnection();
    }
    audio.reset(); released = false;
    panel.hidden = false; wanted = true;
    const token = ++attempt;
    updateControls(); onLayout(); status('영상 연결 중');
    if (prepared !== sourceKey) {
      const pending = prepare();
      // A cached HLS library/native HLS prepares synchronously; preserve the play gesture.
      if (prepared !== sourceKey) await pending;
    }
    if (token !== attempt || !wanted || !channel) return;
    if (prepared !== sourceKey) { wanted = false; updateControls(); return; }
    try {
      if (player && reloadManifest) { reloadManifest = false; player.loadSource(manifestUrl()); }
      player?.startLoad();
      if (video.seekable.length && video.paused) {
        const index = video.seekable.length - 1;
        video.currentTime = Math.max(video.seekable.start(index), video.seekable.end(index) - 2);
      }
      await video.play();
      if (token === attempt && wanted) { status('영상 재생 중'); mediaSession(); updateControls(); }
    } catch (error) {
      if (token !== attempt) return;
      failure(error.name === 'NotAllowedError' ? '재생이 차단되었습니다. 영상 재생을 다시 누르세요.' : '영상 재생 실패 · 다시 시도하세요.');
    }
  }
  function setSource(next) {
    const valid = next?.onAir && next.audioUrl ? next : null;
    const key = valid ? JSON.stringify([valid.id, valid.audioUrl, valid.videoSources]) : '';
    if (key === sourceKey) { channel = valid; return; }
    const resume = wanted && !panel.hidden;
    const wasVideo = !panel.hidden;
    attempt++; wanted = false; resetVideoConnection();
    channel = valid; sourceKey = key; released = false;
    audio.setSource(valid?.audioUrl || '');
    populateQuality(valid?.videoSources?.map(source => source.height) || []);
    if (!valid) { stopVideo(); status('현재 방송 중인 채널을 선택하세요.'); }
    else {
      if (wasVideo) { panel.hidden = false; onLayout(); }
      status(wasVideo ? '영상 채널 변경 중' : '영상 대기');
      prepare();
      if (resume) playVideo();
    }
    updateControls();
  }
  function revealControls() {
    shell.classList.remove('controls-hidden'); window.clearTimeout(chromeTimer);
    if (expanded) chromeTimer = window.setTimeout(() => {
      if (!video.paused && !shell.contains(document.activeElement)) shell.classList.add('controls-hidden');
    }, 3500);
  }
  function releaseOrientation() {
    orientationAttempt++;
    shell.classList.remove('landscape-fallback');
    if (!orientationManaged) return;
    orientationManaged = false;
    try { window.screen?.orientation?.unlock?.(); } catch {}
  }
  async function requestLandscape() {
    const mobile = navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    if (!mobile || !expanded) return;
    // The inner viewport also supplies landscape presentation when OS rotation is unavailable.
    shell.classList.add('landscape-fallback');
    const orientation = window.screen?.orientation;
    if (!orientation?.lock) return;
    const token = ++orientationAttempt; orientationManaged = true;
    try {
      await orientation.lock('landscape');
      if (token !== orientationAttempt && !expanded) { orientationManaged = true; releaseOrientation(); }
    } catch {
      if (token === orientationAttempt) orientationManaged = false;
    }
  }
  async function toggleFullscreen() {
    if (expanded) { exitFullscreen(); return; }
    if (panel.hidden) return;
    if (inPip()) await exitPip();
    try {
      if (shell.requestFullscreen) await shell.requestFullscreen();
      else if (shell.webkitRequestFullscreen) await shell.webkitRequestFullscreen();
      else throw Error('fullscreen unavailable');
    } catch {
      shell.classList.add('is-expanded');
      status('확대 보기 · 브라우저 전체화면은 지원되지 않습니다.');
    }
    fullscreenChanged();
    await requestLandscape();
  }
  async function togglePip() {
    const token = version;
    try {
      if (inPip()) await exitPip();
      else {
        if (expanded) await exitFullscreen();
        if (video.requestPictureInPicture && document.pictureInPictureEnabled) await video.requestPictureInPicture();
        else video.webkitSetPresentationMode('picture-in-picture');
        // Do not let a pending browser request restore PIP after leaving the page.
        if (token !== version || panel.hidden) await exitPip();
      }
    } catch { status('PIP 전환 실패 · 브라우저 설정을 확인하세요.'); }
    updateControls();
  }
  function setCaptions(rows, { live = true } = {}) {
    const recent = live ? rows.filter(row => row.text?.trim()).slice(-100) : [];
    const key = JSON.stringify([live, recent.map(row => [row.id, row.text])]);
    if (key === captionKey) return;
    captionKey = key;
    const overlay = recent.slice(-3).map(row => row.text).join('\n');
    // Keep the end of a long utterance visible rather than clipping new words.
    $('caption-overlay-text').textContent = overlay.slice(-270) || (live ? '새 자막을 기다리고 있습니다.' : '실시간 자막은 오늘 날짜에서 표시됩니다.');
    $('caption-overlay-text').scrollTop = $('caption-overlay-text').scrollHeight;
    const history = $('fullscreen-captions');
    const follow = history.scrollHeight - history.clientHeight - history.scrollTop < 60;
    const children = recent.map(row => {
      const paragraph = document.createElement('p'); paragraph.textContent = row.text; return paragraph;
    });
    if (!children.length) {
      const paragraph = document.createElement('p'); paragraph.textContent = $('caption-overlay-text').textContent; children.push(paragraph);
    }
    $('fullscreen-history').replaceChildren(...children);
    if (follow) history.scrollTop = history.scrollHeight;
  }

  $('video-toggle').onchange = () => {
    if ($('video-toggle').checked) return playVideo();
    stopVideo(); status('영상 정지');
  };
  for (const id of ['video-quality', 'fullscreen-quality']) $(id).onchange = () => {
    quality = $(id).value; applyQuality();
  };
  $('fullscreen-toggle').onclick = toggleFullscreen;
  $('fullscreen-exit').onclick = exitFullscreen;
  $('pip-toggle').onclick = togglePip;
  $('caption-layout').onchange = () => {
    for (const layout of ['overlay', 'split', 'off']) shell.classList.toggle(`caption-layout-${layout}`, $('caption-layout').value === layout);
    $('fullscreen-captions').scrollTop = $('fullscreen-captions').scrollHeight;
  };
  $('fullscreen-play').onclick = () => {
    if (video.paused) playVideo();
    else { wanted = false; attempt++; video.pause(); stopLoading(); status('영상 일시정지'); }
    updateControls(); revealControls();
  };
  video.addEventListener('playing', () => {
    if (!wanted) { video.pause(); return; }
    status('영상 재생 중'); updateControls(); mediaSession(); revealControls();
  });
  video.addEventListener('pause', () => {
    if (!video.paused) return;
    if (wanted) { wanted = false; attempt++; stopLoading(); status('영상 일시정지'); }
    updateControls(); if (!panel.hidden) mediaSession();
  });
  video.addEventListener('waiting', () => { if (wanted) status('영상 버퍼링 중'); });
  video.addEventListener('loadedmetadata', updateControls);
  video.addEventListener('loadeddata', updateControls);
  video.addEventListener('resize', () => { if (!player) showQuality(video.videoHeight); });
  video.addEventListener('ended', () => failure('방송 영상 종료'));
  video.addEventListener('error', () => { if (video.error && !panel.hidden) { prepared = ''; failure('영상 연결 실패 · 다시 시도하세요.'); } });
  for (const name of ['enterpictureinpicture', 'leavepictureinpicture', 'webkitpresentationmodechanged']) video.addEventListener(name, pipChanged);
  for (const name of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(name, fullscreenChanged);
  for (const name of ['pointermove', 'pointerdown', 'touchstart', 'keydown']) shell.addEventListener(name, revealControls, { passive: true });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && expanded) exitFullscreen(); });
  window.addEventListener('pagehide', () => { stopVideo(); audio.suspend(); });
  window.addEventListener('pageshow', event => { if (event.persisted) stopVideo(); });
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => panel.hidden ? audio.play() : playVideo());
      navigator.mediaSession.setActionHandler('pause', () => {
        if (panel.hidden) audio.pause();
        else { wanted = false; attempt++; video.pause(); stopLoading(); updateControls(); }
      });
      navigator.mediaSession.setActionHandler('stop', () => { audio.pause(); stopVideo(); });
    } catch {}
  }
  // Presentation state belongs to this visit, including browser-restored pages.
  stopVideo(); setCaptions([]);
  return { setSource, setCaptions, stop: () => { audio.pause(); stopVideo(); } };
}
