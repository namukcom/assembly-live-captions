import { initAudio, loadHls } from './audio.mjs';
import { createAutoQuality } from './adaptive-video.mjs';
import { originalVariantLoader } from './hls-variants.mjs';

const inactiveBroadcast = /생중계없음|예정|중지|정회|종료|산회|폐회/;
export function isLiveChannel(channel) {
  return Boolean(channel?.onAir && !inactiveBroadcast.test((channel.statusText || '').replace(/\s/g, '')));
}
export function isPlayableChannel(channel) {
  return Boolean(channel?.audioUrl);
}
export function canReceiveCaptions(channel) {
  return Boolean(isLiveChannel(channel) && channel.source);
}

export function initMedia($, { onLayout = () => {}, now = () => performance.now() } = {}) {
  const video = $('broadcast-video'), shell = $('media-shell'), panel = $('media-panel');
  let channel = null, selectedChannel = null, sourceKey = '', player = null, prepared = '', preparing = null;
  let version = 0, preparingVersion = -1, attempt = 0, wanted = false, reloadManifest = false;
  let quality = 'auto', expanded = false, chromeTimer = null, keyboardNavigation = false;
  let captionRows = [], captionLive = true, overlayDirty = true, historyDirty = true, historyChildren = [];
  const historyNodes = new Map(), placeholderKey = Symbol('caption-placeholder');
  let released = false, orientationManaged = false, orientationAttempt = 0;
  let pipActive = false, reloadAfterPip = false;
  let autoQuality = null, qualityTimer = null;
  let qualityNote = '', nextQualityStart = '';
  const videoStorageKey = 'assembly-caption-video-enabled';
  const mutedStorageKey = 'assembly-caption-video-muted';
  let videoEnabled = false;
  try { videoEnabled = window.localStorage?.getItem(videoStorageKey) === 'true'; } catch {}
  try {
    const muted = window.localStorage?.getItem(mutedStorageKey);
    if (muted !== null && muted !== undefined) video.muted = muted === 'true';
  } catch {}
  const audio = initAudio($, { beforePlay: () => stopVideo() });

  function status(message) { $('media-status').textContent = message; }
  function saveVideoPreference(value) {
    videoEnabled = value;
    try { window.localStorage?.setItem(videoStorageKey, String(value)); } catch {}
  }
  function saveMutedPreference() {
    try { window.localStorage?.setItem(mutedStorageKey, String(video.muted)); } catch {}
  }
  function unavailableMessage() {
    if (!selectedChannel) return '방송 채널을 선택하세요.';
    const state = selectedChannel.statusText || '';
    const reason = isLiveChannel(selectedChannel) ?
      '재생 주소 확인 중' : state || '현재 방송 중이 아님';
    return `${selectedChannel.name} · ${reason}`;
  }
  function playingStatus() { return `${video.muted ? '영상 재생 중 · 음소거' : '영상 재생 중'}${qualityNote ? ` · ${qualityNote}` : ''}`; }
  function isFullscreen() { return document.fullscreenElement === shell || document.webkitFullscreenElement === shell; }
  function inPip() { return document.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture'; }
  function supportedPip() {
    return Boolean((document.pictureInPictureEnabled && video.requestPictureInPicture) ||
      video.webkitSupportsPresentationMode?.('picture-in-picture'));
  }
  function updateControls() {
    const active = Boolean(channel && !panel.hidden);
    $('video-toggle').checked = active && wanted;
    $('video-options').hidden = !active;
    $('video-toggle').disabled = !channel;
    $('video-quality').disabled = !active;
    $('fullscreen-quality').disabled = !active;
    $('pip-toggle').disabled = !active || (!inPip() && (video.paused || !wanted || video.readyState < 2 || !supportedPip()));
    $('pip-toggle').setAttribute('aria-pressed', String(inPip()));
    $('pip-toggle').title = supportedPip() ? '작은 창으로 영상 보기 (자막 제외)' : '이 브라우저는 PIP를 지원하지 않습니다';
    $('fullscreen-toggle').disabled = !active;
    $('fullscreen-play').disabled = !channel;
    for (const id of ['video-sound', 'fullscreen-sound']) {
      $(id).disabled = !active;
      $(id).textContent = video.muted ? '소리 켜기' : '음소거';
      $(id).setAttribute('aria-label', video.muted ? '영상 소리 켜기' : '영상 음소거');
      $(id).setAttribute('aria-pressed', String(Boolean(video.muted)));
    }
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
    stopQualityMonitor();
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
    syncCaptionPresentation(); updateControls(); onLayout();
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
    stopQualityMonitor();
    autoQuality = null; qualityNote = ''; nextQualityStart = '';
    $('media-status').title = '';
    video.pause();
    const previous = player; player = null; previous?.destroy();
    prepared = ''; reloadManifest = false; reloadAfterPip = false;
    video.removeAttribute('src'); video.load();
  }
  function stopVideo({ preservePreference = false } = {}) {
    if (!preservePreference) saveVideoPreference(false);
    attempt++; wanted = false; released = true; panel.hidden = true; pipActive = false;
    resetVideoConnection();
    window.clearTimeout(chromeTimer); chromeTimer = null;
    shell.classList.remove('controls-hidden');
    if (historyChildren.length) $('fullscreen-history').replaceChildren();
    historyNodes.clear(); historyChildren = []; historyDirty = true;
    exitPip(); exitFullscreen();
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } catch {}
    }
    status('영상 정지'); updateControls(); onLayout();
  }
  function failure(message) {
    if (player && quality === 'auto' && wanted && autoQuality?.fallback() && switchAutoSource()) return;
    stopVideo(); status(message);
  }
  function stopQualityMonitor() {
    window.clearTimeout(qualityTimer); qualityTimer = null;
  }
  function switchAutoSource() {
    const level = player?.levels.findIndex(level => level.height === autoQuality?.height) ?? -1;
    if (level < 0) return false;
    player.currentLevel = level;
    player.startLoad();
    showQuality(autoQuality.height);
    qualityNote = `자동 ${autoQuality.height}p · ${autoQuality.reason}`;
    if (wanted && !video.paused) status(playingStatus());
    return true;
  }
  function startQualityMonitor() {
    stopQualityMonitor();
    if (!player || !autoQuality || quality !== 'auto' || !wanted || video.paused) return;
    autoQuality.resume();
    const token = version;
    function sample() {
      qualityTimer = null;
      if (token !== version || !wanted || quality !== 'auto' || video.paused || !autoQuality) return;
      if (document.visibilityState !== 'hidden' && !inPip() && player.levels[player.currentLevel]?.height === autoQuality.height) {
        let buffer = 0;
        for (let index = 0; index < video.buffered.length; index++) {
          if (video.buffered.start(index) <= video.currentTime && video.currentTime < video.buffered.end(index)) {
            buffer = video.buffered.end(index) - video.currentTime; break;
          }
        }
        const frames = video.getVideoPlaybackQuality?.();
        $('media-status').title = `버퍼 ${buffer.toFixed(1)}초 · 다운로드 ${((player.bandwidthEstimate || 0) / 1e6).toFixed(1)}Mbps · 프레임 드롭 ${frames?.droppedVideoFrames ?? '?'} / ${frames?.totalVideoFrames ?? '?'}`;
        const height = autoQuality.sample({ buffer, currentTime: video.currentTime,
          bandwidth: player?.bandwidthEstimate || navigator.connection?.downlink * 1e6,
          bitrate: player.levels[player.currentLevel]?.bitrate,
          totalFrames: frames?.totalVideoFrames ?? video.webkitDecodedFrameCount,
          droppedFrames: frames?.droppedVideoFrames ?? video.webkitDroppedFrameCount,
          saveData: Boolean(navigator.connection?.saveData) });
        if (height) switchAutoSource();
      } else autoQuality.resume();
      qualityTimer = window.setTimeout(sample, 5000);
    }
    qualityTimer = window.setTimeout(sample, 5000);
  }
  function playbackUrl() {
    const defaultUrl = channel.videoDefaultUrl || channel.audioUrl;
    // Use the Assembly's own playlist unchanged, including its query parameters.
    const height = quality === 'auto' ? autoQuality?.height : Number(quality);
    return channel.videoSources?.find(source => source.height === height)?.url || defaultUrl;
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
    if (!channel) return;
    const resume = wanted;
    wanted = false; attempt++; resetVideoConnection();
    showQuality(0);
    // Like the original player, switching quality starts a fresh selected source.
    if (resume) return playVideo();
    return Promise.resolve();
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
        let Hls = window.Hls;
        if (!Hls && (!(safari && native) || autoQuality)) {
          try { Hls = await loadHls(); } catch (error) { if (!native) throw error; }
        }
        if (token !== version) return;
        if (safari && native && !Hls?.isSupported()) {
          // Native HLS cannot change independent source URLs without resetting decoding.
          autoQuality = null;
          video.src = playbackUrl();
        } else {
          const url = playbackUrl();
          if (Hls.isSupported()) {
            const current = new Hls({ autoStartLoad: false, startLevel: 0, testBandwidth: false,
              maxBufferLength: 30, backBufferLength: 10,
              ...(autoQuality ? { pLoader: originalVariantLoader(Hls, channel.videoSources) } : {}),
              abrBandWidthUpFactor: 0.65, capLevelOnFPSDrop: true });
            player = current;
            current.on(Hls.Events.MANIFEST_PARSED, () => {
              if (current !== player) return;
              populateQuality(channel.videoSources?.map(source => source.height) || current.levels.map(level => level.height));
              if (autoQuality) {
                autoQuality = createAutoQuality({ ...channel, videoDefaultUrl: url, videoSources: channel.videoSources.filter(source => current.levels.some(level => level.height === source.height)) }, now);
              }
              if (autoQuality || quality !== 'auto') current.loadLevel = Math.max(0, current.levels.findIndex(level => level.height === autoQuality?.height));
            });
            current.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
              if (current !== player) return;
              const height = current.levels[data.level]?.height;
              showQuality(height);
              if (autoQuality && height === autoQuality.height) {
                qualityNote = `${nextQualityStart || `자동 ${height}p`} · ${autoQuality.reason}`;
                nextQualityStart = '';
                if (wanted && !video.paused) status(playingStatus());
              }
            });
            current.on(Hls.Events.ERROR, (_event, data) => {
              if (current !== player || !data.fatal) return;
              failure('영상 연결 실패 · 영상 재생을 다시 누르세요.');
            });
            current.attachMedia(video); current.loadSource(url);
          } else if (native) video.src = url;
          else throw Error('이 브라우저는 영상 재생을 지원하지 않습니다.');
        }
        if (token !== version) return;
        prepared = key;
      } catch (error) { if (token === version) failure(error.message); }
    })();
    // Cleanup must run after assignment even when native HLS prepares synchronously.
    const job = task.finally(() => {
      if (preparing === job) preparing = null;
      if (token !== version && channel && !released) prepare();
    });
    preparing = job;
    return job;
  }
  async function playVideo({ automatic = false } = {}) {
    if (!channel) { updateControls(); return; }
    if (!automatic) saveVideoPreference(true);
    if (reloadAfterPip) {
      wanted = false; attempt++; resetVideoConnection();
    }
    audio.reset(); released = false;
    if (quality === 'auto' && !autoQuality) {
      autoQuality = createAutoQuality(channel, now);
      if (autoQuality) qualityNote = nextQualityStart || `자동 ${autoQuality.height}p에서 시작`;
    }
    panel.hidden = false; wanted = true; updateOverlay();
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
      if (player && reloadManifest) { reloadManifest = false; player.loadSource(playbackUrl()); }
      player?.startLoad();
      if (video.seekable.length) {
        const last = video.seekable.length - 1;
        video.currentTime = Math.max(video.seekable.start(last), video.seekable.end(last) - 2);
      }
      await video.play();
      if (token === attempt && wanted) { status(playingStatus()); mediaSession(); updateControls(); }
    } catch (error) {
      if (token !== attempt) return;
      const blockedMessage = automatic && !video.muted ?
        '소리 있는 자동 재생이 차단되었습니다. 영상 재생을 누르면 소리와 함께 시작합니다.' :
        '재생이 차단되었습니다. 영상 재생을 다시 누르세요.';
      if (automatic && error.name === 'NotAllowedError') {
        stopVideo(); status(blockedMessage);
      } else failure(error.name === 'NotAllowedError' ? blockedMessage : '영상 재생 실패 · 다시 시도하세요.');
    }
  }
  function setSource(next) {
    selectedChannel = next || null;
    const valid = isPlayableChannel(next) ? next : null;
    const key = valid ? JSON.stringify([valid.id, valid.audioUrl, valid.videoSources, valid.videoDefaultUrl]) : '';
    if (key === sourceKey) {
      channel = valid;
      if (!valid) { audio.setSource('', unavailableMessage()); status(unavailableMessage()); }
      updateControls(); return;
    }
    const resume = videoEnabled;
    const wasVideo = !panel.hidden;
    const sourceChanged = Boolean(channel && valid);
    attempt++; wanted = false; resetVideoConnection();
    nextQualityStart = sourceChanged ? '채널·재생 주소 변경으로 초기화' : '';
    channel = valid; sourceKey = key; released = false;
    audio.setSource(valid?.audioUrl || '', unavailableMessage());
    populateQuality(valid?.videoSources?.map(source => source.height) || []);
    if (!valid) { stopVideo({ preservePreference: true }); status(unavailableMessage()); }
    else {
      if (wasVideo) { panel.hidden = false; onLayout(); }
      status(wasVideo ? '영상 채널 변경 중' : '영상 대기');
      if (resume) playVideo({ automatic: true });
    }
    updateControls();
  }
  function revealControls() {
    shell.classList.remove('controls-hidden'); window.clearTimeout(chromeTimer);
    if (expanded) chromeTimer = window.setTimeout(() => {
      if (!video.paused && !(keyboardNavigation && shell.contains(document.activeElement))) shell.classList.add('controls-hidden');
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
    const token = version;
    if (inPip()) await exitPip();
    if (token !== version || panel.hidden) return;
    try {
      if (shell.requestFullscreen) await shell.requestFullscreen();
      else if (shell.webkitRequestFullscreen) await shell.webkitRequestFullscreen();
      else throw Error('fullscreen unavailable');
    } catch {
      if (token !== version || panel.hidden) return;
      shell.classList.add('is-expanded');
      status('확대 보기 · 브라우저 전체화면은 지원되지 않습니다.');
    }
    if (token !== version || panel.hidden) { await exitFullscreen(); return; }
    fullscreenChanged();
    await requestLandscape();
  }
  async function togglePip() {
    const token = version;
    try {
      if (inPip()) await exitPip();
      else {
        if (expanded) await exitFullscreen();
        if (token !== version || panel.hidden) return;
        if (video.requestPictureInPicture && document.pictureInPictureEnabled) await video.requestPictureInPicture();
        else video.webkitSetPresentationMode('picture-in-picture');
        // Do not let a pending browser request restore PIP after leaving the page.
        if (token !== version || panel.hidden) await exitPip();
      }
    } catch { status('PIP 전환 실패 · 브라우저 설정을 확인하세요.'); }
    updateControls();
  }
  function updateOverlay() {
    if (!overlayDirty) return;
    overlayDirty = false;
    const latest = [];
    if (captionLive) for (let index = captionRows.length - 1; index >= 0 && latest.length < 3; index--) {
      if (captionRows[index].text?.trim()) latest.push(captionRows[index].text);
    }
    latest.reverse();
    const overlay = latest.join('\n');
    // Keep the end of a long utterance visible rather than clipping new words.
    const nextOverlay = overlay.slice(-270) || (captionLive ? '새 자막을 기다리고 있습니다.' : '실시간 자막은 오늘 날짜에서 표시됩니다.');
    if ($('caption-overlay-text').textContent !== nextOverlay) $('caption-overlay-text').textContent = nextOverlay;
  }
  function setCaptions(rows, { live = true } = {}) {
    captionRows = live ? rows : []; captionLive = live;
    historyDirty = true; overlayDirty = true;
    if (!panel.hidden || !rows.length) updateOverlay();
    syncCaptionPresentation();
  }
  function syncCaptionPresentation() {
    if (!expanded || panel.hidden) return;
    updateOverlay();
    if (!shell.classList.contains('caption-layout-split')) {
      if (!shell.classList.contains('caption-layout-off')) $('caption-overlay-text').scrollTop = $('caption-overlay-text').scrollHeight;
      return;
    }
    if (!historyDirty) return;
    historyDirty = false;
    const recent = [];
    for (let index = captionRows.length - 1; index >= 0 && recent.length < 100; index--) {
      if (captionRows[index].text?.trim()) recent.push(captionRows[index]);
    }
    recent.reverse();
    const history = $('fullscreen-captions');
    const follow = history.scrollHeight - history.clientHeight - history.scrollTop < 60;
    const visible = recent.length ? recent : [{ id: placeholderKey, text: $('caption-overlay-text').textContent }];
    const keep = new Set();
    const children = visible.map(row => {
      keep.add(row.id);
      let paragraph = historyNodes.get(row.id);
      if (!paragraph) { paragraph = document.createElement('p'); historyNodes.set(row.id, paragraph); }
      if (paragraph.textContent !== row.text) paragraph.textContent = row.text;
      return paragraph;
    });
    for (const id of historyNodes.keys()) if (!keep.has(id)) historyNodes.delete(id);
    if (children.length !== historyChildren.length || children.some((child, index) => child !== historyChildren[index])) {
      $('fullscreen-history').replaceChildren(...children); historyChildren = children;
    }
    if (follow) history.scrollTop = history.scrollHeight;
  }

  $('video-toggle').onchange = () => {
    if ($('video-toggle').checked) return playVideo();
    stopVideo(); status('영상 정지');
  };
  for (const id of ['video-quality', 'fullscreen-quality']) $(id).onchange = () => {
    quality = $(id).value; return applyQuality();
  };
  $('fullscreen-toggle').onclick = toggleFullscreen;
  $('fullscreen-exit').onclick = exitFullscreen;
  $('pip-toggle').onclick = togglePip;
  for (const id of ['video-sound', 'fullscreen-sound']) $(id).onclick = () => {
    if (!channel || panel.hidden) return;
    video.muted = !video.muted;
    saveMutedPreference();
    if (wanted && !video.paused) status(playingStatus());
    updateControls();
  };
  $('caption-layout').onchange = () => {
    for (const layout of ['overlay', 'split', 'off']) shell.classList.toggle(`caption-layout-${layout}`, $('caption-layout').value === layout);
    syncCaptionPresentation();
    if (expanded && $('caption-layout').value === 'split') $('fullscreen-captions').scrollTop = $('fullscreen-captions').scrollHeight;
  };
  $('fullscreen-play').onclick = () => {
    if (video.paused) playVideo();
    else { saveVideoPreference(false); wanted = false; attempt++; video.pause(); stopLoading(); status('영상 일시정지'); }
    updateControls(); revealControls();
  };
  video.addEventListener('playing', () => {
    if (!wanted) { video.pause(); return; }
    status(playingStatus()); updateControls(); mediaSession(); revealControls(); startQualityMonitor();
  });
  video.addEventListener('pause', () => {
    if (!video.paused) return;
    stopQualityMonitor();
    if (wanted) { saveVideoPreference(false); wanted = false; attempt++; stopLoading(); status('영상 일시정지'); }
    updateControls(); revealControls(); if (!panel.hidden) mediaSession();
  });
  video.addEventListener('waiting', () => { if (wanted) { if (qualityTimer !== null) autoQuality?.stall(); status('영상 버퍼링 중'); } });
  for (const name of ['loadedmetadata', 'loadeddata']) video.addEventListener(name, updateControls);
  video.addEventListener('volumechange', () => {
    saveMutedPreference();
    if (wanted && !video.paused) status(playingStatus());
    updateControls();
  });
  video.addEventListener('resize', () => { if (!player) showQuality(video.videoHeight); });
  video.addEventListener('ended', () => { stopVideo(); status('방송 영상 종료'); });
  video.addEventListener('error', () => { if (video.error && !panel.hidden) { prepared = ''; failure('영상 연결 실패 · 다시 시도하세요.'); } });
  for (const name of ['enterpictureinpicture', 'leavepictureinpicture', 'webkitpresentationmodechanged']) video.addEventListener(name, pipChanged);
  for (const name of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(name, fullscreenChanged);
  let lastControlReveal = 0;
  for (const name of ['pointermove', 'pointerdown', 'touchstart', 'keydown', 'focusin', 'focusout']) shell.addEventListener(name, () => {
    if (name === 'keydown') keyboardNavigation = true;
    else if (name === 'pointerdown' || name === 'touchstart') keyboardNavigation = false;
    if (name === 'pointermove') {
      const now = Date.now();
      if (!shell.classList.contains('controls-hidden') && now - lastControlReveal < 200) return;
      lastControlReveal = now;
    }
    revealControls();
  }, { passive: true });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && expanded) exitFullscreen(); });
  window.addEventListener('pagehide', () => {
    saveMutedPreference(); stopVideo({ preservePreference: true }); audio.suspend();
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    stopVideo({ preservePreference: true }); audio.suspend();
    if (videoEnabled && channel) playVideo({ automatic: true });
  });
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => panel.hidden ? audio.play() : playVideo());
      navigator.mediaSession.setActionHandler('pause', () => {
        if (panel.hidden) audio.pause();
        else { saveVideoPreference(false); wanted = false; attempt++; video.pause(); stopLoading(); status('영상 일시정지'); updateControls(); revealControls(); mediaSession(); }
      });
      navigator.mediaSession.setActionHandler('stop', () => { audio.pause(); stopVideo(); });
    } catch {}
  }
  // Presentation state belongs to this visit, including browser-restored pages.
  stopVideo({ preservePreference: true }); setCaptions([]);
  return { setSource, setCaptions, stop: () => { audio.pause(); stopVideo(); } };
}
