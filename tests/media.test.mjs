import test from 'node:test';
import assert from 'node:assert/strict';
import { initMedia } from '../media.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
function startVideo($) { $('video-toggle').checked = true; return $('video-toggle').onchange(); }
const channel = id => ({ id, name: `위원회 ${id}`, onAir: true,
  source: `wss://captions.test/${id}`,
  audioUrl: `https://w-assembly.hscdn.com/assembly/${id}_240p/playlist.m3u8`,
  videoSources: [240, 480, 720, 1080].map(height => ({ height,
    url: `https://w-assembly.hscdn.com/assembly/${id}_${height}p/playlist.m3u8` })),
});

function setup(t, { safari = false, delayed = false, mobile = false, restoredPip = false, savedEntries = [] } = {}) {
  const nodes = {}, players = [], scripts = [], docEvents = {}, winEvents = {}, originals = new Map(), saved = new Map(savedEntries);
  const element = () => {
    const classes = new Set(), events = {};
    return { value: '', textContent: '', hidden: false, disabled: false, checked: false, children: [], attributes: {},
      src: '', buffered: { length: 0 }, readyState: 2, paused: true, muted: false, seekable: { length: 0 }, scrollHeight: 300, clientHeight: 100, scrollTop: 200,
      classList: { contains: value => classes.has(value), add: value => classes.add(value), remove: value => classes.delete(value),
        toggle(value, force) { if (force ?? !classes.has(value)) classes.add(value); else classes.delete(value); } },
      contains() { return false; },
      setAttribute(key, value) { this.attributes[key] = value; },
      querySelector(selector) { return this.children.find(child => child.value === 'auto'); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(name, fn) { events[name] = fn; }, emit(name) { events[name]?.({}); },
      canPlayType() { return safari ? 'maybe' : ''; },
      playCalls: 0, play() { this.playCalls++; this.buffered.length = 1; this.paused = false; this.emit('playing'); return Promise.resolve(); },
      pause() { this.paused = true; this.emit('pause'); },
      loadCalls: 0, load() { this.loadCalls++; this.buffered.length = 0; }, removeAttribute(name) { if (name === 'src') this.src = ''; },
    };
  };
  const $ = id => nodes[id] ??= element();
  $('media-panel').hidden = true;
  class Hls {
    static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifest', LEVEL_SWITCHED: 'level' };
    static isSupported() { return true; }
    levels = []; currentLevel = -1; loadLevel = -1; listeners = {};
    constructor(options) { this.options = options; players.push(this); }
    on(name, fn) { this.listeners[name] = fn; }
    attachMedia(media) { this.media = media; media.src = `blob:player-${players.length}`; }
    loadSource(url) { this.url = url; queueMicrotask(() => {
      if (this.destroyed) return;
      this.levels = [240, 480, 720, 1080].map(height => ({ height })); this.listeners.manifest?.();
    }); }
    startLoad() { this.loading = true; } stopLoad() { this.loading = false; }
    destroy() { this.destroyed = true; this.loading = false; }
  }
  const document = { createElement: element, head: { append(script) { scripts.push(script); } },
    body: element(), fullscreenElement: null, pictureInPictureEnabled: true, pictureInPictureElement: null,
    addEventListener(name, fn) { docEvents[name] = fn; },
    async exitFullscreen() { this.fullscreenElement = null; docEvents.fullscreenchange?.(); },
    async exitPictureInPicture() { this.pictureInPictureElement = null; $('broadcast-video').emit('leavepictureinpicture'); },
  };
  $('media-shell').requestFullscreen = async () => { document.fullscreenElement = $('media-shell'); docEvents.fullscreenchange?.(); };
  $('broadcast-video').requestPictureInPicture = async () => { document.pictureInPictureElement = $('broadcast-video'); $('broadcast-video').emit('enterpictureinpicture'); };
  if (restoredPip) document.pictureInPictureElement = $('broadcast-video');
  const window = { Hls: delayed ? undefined : Hls, localStorage: { getItem(key) { return saved.get(key) ?? null; }, setItem(key, value) { saved.set(key, value); }, removeItem(key) { saved.delete(key); } },
    setTimeout() { return 1; }, clearTimeout() {}, addEventListener(name, fn) { winEvents[name] = fn; } };
  for (const [name, value] of Object.entries({ document, window, navigator: { userAgent: mobile ? (safari ? 'iPhone Version/18 Safari' : 'Android Chrome') : safari ? 'Version/18 Safari' : 'Chrome' } })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  t.after(() => { for (const [name, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]; });
  return { $, controller: initMedia($), players, document, window, scripts, Hls, docEvents, winEvents, saved };
}

test('오디오↔영상 전환은 하나만 재생하고 저화질 시작·자동 및 수동 화질을 제공한다', async t => {
  const { $, controller, players } = setup(t);
  controller.setSource(channel('19')); await settle();
  assert.equal($('video-toggle').checked, false);
  assert.equal($('video-options').hidden, true);
  $('audio-toggle').checked = true; await $('audio-toggle').onchange();
  assert.equal($('broadcast-audio').paused, false);
  await startVideo($);
  assert.equal($('broadcast-audio').paused, true); assert.equal($('audio-toggle').checked, false);
  assert.equal($('broadcast-video').paused, false); assert.equal($('media-panel').hidden, false);
  assert.equal($('video-toggle').checked, true);
  assert.equal($('video-options').hidden, false);
  const videoPlayer = players.findLast(player => player.media === $('broadcast-video'));
  assert.equal(videoPlayer.options.startLevel, 0); assert.equal(videoPlayer.options.testBandwidth, false);
  $('video-quality').value = '720'; $('video-quality').onchange(); assert.equal(videoPlayer.loadLevel, 2);
  $('fullscreen-quality').value = 'auto'; $('fullscreen-quality').onchange(); assert.equal(videoPlayer.loadLevel, -1);
  videoPlayer.listeners.level(null, { level: 3 });
  assert.equal($('video-quality').children[0].textContent, '자동 · 1080p');
  $('audio-toggle').checked = true; await $('audio-toggle').onchange();
  assert.equal($('broadcast-video').paused, true); assert.equal($('media-panel').hidden, true);
  assert.equal($('broadcast-audio').paused, false); assert.equal(videoPlayer.loading, false);
  assert.equal($('video-toggle').checked, false);
  assert.equal($('video-options').hidden, true, '오디오로 전환하면 영상 옵션을 접는다');
  await startVideo($);
  $('video-toggle').checked = false; $('video-toggle').onchange();
  assert.equal($('broadcast-video').paused, true);
  assert.equal($('media-panel').hidden, true);
  assert.equal($('video-options').hidden, true, '영상 스위치를 끄면 영상과 옵션을 함께 접는다');
});

test('전체화면 자막·분할·PIP 전환을 처리하고 오디오 전환 시 모두 종료한다', async t => {
  const { $, controller, document } = setup(t);
  controller.setSource(channel('19')); await settle(); await startVideo($);
  controller.setCaptions([{ id: 1, text: '<script>자막은 텍스트</script>' }, { id: 2, text: '최신 발언' }]);
  assert.match($('caption-overlay-text').textContent, /최신 발언/);
  assert.equal($('fullscreen-history').children[0].textContent, '<script>자막은 텍스트</script>');
  await $('fullscreen-toggle').onclick(); assert.equal(document.fullscreenElement, $('media-shell'));
  $('caption-layout').value = 'split'; $('caption-layout').onchange();
  assert.equal($('media-shell').classList.contains('caption-layout-split'), true);
  await $('pip-toggle').onclick(); assert.equal(document.fullscreenElement, null);
  assert.equal(document.pictureInPictureElement, $('broadcast-video'));
  await $('fullscreen-toggle').onclick(); assert.equal(document.pictureInPictureElement, null);
  $('audio-toggle').checked = true; await $('audio-toggle').onchange();
  assert.equal(document.fullscreenElement, null); assert.equal($('media-panel').hidden, true);
  controller.setCaptions([], { live: false }); assert.match($('caption-overlay-text').textContent, /오늘 날짜/);
});

test('기본 전체화면이 거절되면 자막을 유지하는 확대 보기로 전환하고 Escape로 복귀한다', async t => {
  const { $, controller, docEvents } = setup(t);
  controller.setSource(channel('19')); await settle(); await startVideo($);
  $('media-shell').requestFullscreen = async () => { throw Error('not supported'); };
  await $('fullscreen-toggle').onclick(); assert.equal($('media-shell').classList.contains('is-expanded'), true);
  docEvents.keydown({ key: 'Escape' }); assert.equal($('media-shell').classList.contains('is-expanded'), false);
});

for (const safari of [false, true]) {
test(`${safari ? 'Safari PIP' : '표준 PIP'}: 다른 탭 재생으로 종료된 뒤 새 연결로 인라인 재생한다`, async t => {
  const { $, controller, players, document, saved } = setup(t, { safari });
  const video = $('broadcast-video');
  if (safari) {
    document.pictureInPictureEnabled = false;
    video.webkitPresentationMode = 'inline';
    video.webkitSupportsPresentationMode = () => true;
    video.webkitSetPresentationMode = mode => {
      video.webkitPresentationMode = mode; video.emit('webkitpresentationmodechanged');
    };
  }
  controller.setSource(channel('19')); await settle(); await startVideo($);
  await $('pip-toggle').onclick();
  const previous = players.findLast(player => player.media === video), loads = video.loadCalls;
  video.pause();
  if (safari) video.webkitSetPresentationMode('inline');
  else await document.exitPictureInPicture();
  assert.equal($('pip-toggle').attributes['aria-pressed'], 'false');
  assert.equal($('video-toggle').checked, false, '브라우저가 중지한 재생 상태를 스위치에도 반영한다');
  const calls = video.playCalls;
  await startVideo($); await settle();
  assert.ok(video.loadCalls > loads, 'PIP 종료 뒤에는 영상 연결을 새로 준비한다');
  if (previous) {
    assert.equal(previous.destroyed, true);
    assert.notEqual(players.findLast(player => player.media === video), previous);
  }
  assert.equal(video.playCalls, calls + 1);
  assert.equal(video.paused, false); assert.equal($('media-panel').hidden, false);
  assert.equal($('pip-toggle').attributes['aria-pressed'], 'false');
  assert.deepEqual([...saved.keys()], ['assembly-caption-video-enabled'], '영상 선택만 기억하고 오디오와 PIP 상태는 저장하지 않는다');
});
}

test('접속 및 뒤로가기로 페이지를 복원할 때 PIP는 초기화하고 영상은 인라인으로 이어 재생한다', async t => {
  const { $, controller, document, winEvents } = setup(t, { restoredPip: true });
  assert.equal(document.pictureInPictureElement, null);
  assert.equal($('pip-toggle').attributes['aria-pressed'], 'false');
  controller.setSource(channel('19')); await settle(); await startVideo($);
  await $('pip-toggle').onclick();
  winEvents.pageshow({ persisted: true });
  await settle();
  assert.equal(document.pictureInPictureElement, null);
  assert.equal($('broadcast-video').paused, false);
  assert.equal($('media-panel').hidden, false);
  assert.equal($('video-toggle').checked, true);
  assert.equal(document.pictureInPictureElement, null);
});

test('페이지를 떠난 뒤 완료된 PIP 요청은 창을 다시 열어 두지 않는다', async t => {
  const { $, controller, document, winEvents } = setup(t);
  controller.setSource(channel('19')); await settle(); await startVideo($);
  let finish;
  $('broadcast-video').requestPictureInPicture = () => new Promise(resolve => {
    finish = () => {
      document.pictureInPictureElement = $('broadcast-video');
      $('broadcast-video').emit('enterpictureinpicture'); resolve();
    };
  });
  const entering = $('pip-toggle').onclick();
  winEvents.pagehide(); finish(); await entering;
  assert.equal(document.pictureInPictureElement, null);
  assert.equal($('pip-toggle').attributes['aria-pressed'], 'false');
  assert.equal($('media-panel').hidden, true);
  assert.equal($('broadcast-video').paused, true);
});

test('영상 모드에서 채널 변경을 이어 재생하고 방송 종료 때 재생·PIP·플레이어를 정리한다', async t => {
  const { $, controller, players, document } = setup(t);
  controller.setSource(channel('19')); await settle(); await startVideo($);
  controller.setSource(channel('25')); await settle(); await settle();
  assert.equal($('broadcast-video').paused, false);
  assert.ok(players.find(player => player.url === '/api/video.m3u8?channel=25'));
  await $('pip-toggle').onclick(); controller.setSource(null);
  assert.equal($('broadcast-video').paused, true); assert.equal(document.pictureInPictureElement, null);
  assert.equal($('media-panel').hidden, true); assert.equal($('video-toggle').disabled, true);
});

test('Safari는 기본 HLS로 재생하고 수동 화질과 자동 목록을 전환한다', async t => {
  const { $, controller, players } = setup(t, { safari: true });
  controller.setSource(channel('19')); await settle(); await startVideo($);
  assert.equal(players.length, 0); assert.equal($('broadcast-video').src, '/api/video.m3u8?channel=19');
  $('video-quality').value = '1080'; $('video-quality').onchange();
  assert.match($('broadcast-video').src, /19_1080p/); assert.equal($('broadcast-video').paused, false);
  $('video-quality').value = 'auto'; $('video-quality').onchange(); assert.equal($('broadcast-video').src, '/api/video.m3u8?channel=19');
  controller.setSource(channel('25')); await settle(); await settle();
  assert.equal($('broadcast-video').src, '/api/video.m3u8?channel=25');
  assert.equal($('broadcast-video').paused, false, '기본 HLS를 사용하는 Safari도 채널 변경 후 재생한다');
});

test('라이브러리 준비 중 채널·모드를 바꿔도 오래된 영상 재생이 오디오를 끊지 않는다', async t => {
  const { $, controller, scripts, Hls, window } = setup(t, { delayed: true });
  controller.setSource(channel('19')); const starting = startVideo($);
  controller.setSource(channel('25'));
  $('audio-toggle').checked = true; const audioStarting = $('audio-toggle').onchange();
  window.Hls = Hls; scripts[0].onload();
  await starting; await audioStarting; await settle(); await settle();
  assert.equal($('broadcast-video').playCalls, 0); assert.equal($('media-panel').hidden, true);
  assert.equal($('broadcast-audio').paused, false);
});

test('페이지를 떠나거나 복원할 때 오디오를 끄고 켬 상태를 저장하지 않는다', async t => {
  const { $, controller, winEvents, saved } = setup(t);
  controller.setSource(channel('19')); await settle();
  $('audio-toggle').checked = true; await $('audio-toggle').onchange();
  winEvents.pagehide();
  assert.equal($('broadcast-audio').paused, true);
  assert.equal($('audio-toggle').checked, false);
  assert.equal(saved.has('assembly-caption-audio-enabled'), false);
  winEvents.pageshow({ persisted: true });
  assert.equal($('broadcast-audio').paused, true);
  assert.equal($('audio-toggle').checked, false);
});

for (const safari of [false, true]) {
test(`${safari ? 'Safari' : 'HLS.js'}: 영상 선택은 복원하고 오디오는 끄며 자동 재생 차단 시 음소거로 재시도한다`, async t => {
  const { $, controller, saved, document } = setup(t, { safari, savedEntries: [
    ['assembly-caption-video-enabled', 'true'], ['assembly-caption-audio-enabled', 'true'],
  ] });
  const video = $('broadcast-video'), originalPlay = video.play, mutedAttempts = [];
  video.play = function () {
    mutedAttempts.push(this.muted);
    if (!this.muted) return Promise.reject(Object.assign(Error('blocked'), { name: 'NotAllowedError' }));
    return originalPlay.call(this);
  };
  controller.setSource(channel('25')); await settle(); await settle();
  assert.deepEqual(mutedAttempts, [false, true]);
  assert.equal(video.paused, false); assert.equal(video.muted, true);
  assert.equal($('video-toggle').checked, true);
  assert.equal($('audio-toggle').checked, false); assert.equal($('broadcast-audio').playCalls, 0);
  assert.equal(saved.has('assembly-caption-audio-enabled'), false);
  assert.equal($('video-sound').textContent, '소리 켜기');
  assert.equal($('fullscreen-sound').textContent, '소리 켜기');
  assert.equal(document.pictureInPictureElement, null);
  $('video-sound').onclick();
  assert.equal(video.muted, false); assert.equal($('video-sound').textContent, '음소거');
  $('fullscreen-sound').onclick(); assert.equal(video.muted, true);
  $('video-toggle').checked = false; $('video-toggle').onchange();
  assert.equal(saved.get('assembly-caption-video-enabled'), 'false');
});
}

test('영상의 음소거 자동 재생도 차단되면 켬으로 표시하지 않고 수동 재생을 안내한다', async t => {
  const { $, controller, players } = setup(t, { savedEntries: [['assembly-caption-video-enabled', 'true']] });
  const attempts = [];
  $('broadcast-video').play = function () {
    attempts.push(this.muted); return Promise.reject(Object.assign(Error('blocked'), { name: 'NotAllowedError' }));
  };
  controller.setSource(channel('25')); await settle(); await settle();
  assert.deepEqual(attempts, [false, true]);
  assert.equal($('video-toggle').checked, false);
  assert.equal($('audio-toggle').checked, false);
  assert.equal($('pip-toggle').disabled, true);
  assert.match($('media-status').textContent, /재생이 차단/);
  assert.equal(players.findLast(player => player.media === $('broadcast-video')).loading, false);
});

test('재생 주소가 없을 때만 미디어를 비활성화하고 주소가 확인되면 영상 선택을 복원한다', async t => {
  const { $, controller, players, saved } = setup(t, { savedEntries: [['assembly-caption-video-enabled', 'true']] });
  assert.equal($('audio-toggle').disabled, true);
  assert.equal($('video-toggle').disabled, true);
  for (const statusText of ['생중계 없음', '10:00 감사예정', '감사중지', '감사종료', '20:30 계속예정']) {
    for (const onAir of [false, true]) {
      controller.setSource({ ...channel('25'), onAir, statusText, audioUrl: '' });
      await settle();
      assert.equal($('audio-toggle').disabled, true, statusText);
      assert.equal($('video-toggle').disabled, true, statusText);
      assert.equal($('pip-toggle').disabled, true);
      assert.equal($('fullscreen-toggle').disabled, true);
      assert.equal($('video-quality').disabled, true);
      assert.ok($('audio-status').textContent.includes(statusText));
      assert.equal($('broadcast-video').playCalls, 0);
      assert.equal($('broadcast-audio').playCalls, 0);
    }
  }
  assert.equal(players.length, 0, '재생 불가 상태에서는 연결을 준비하지 않는다');
  controller.setSource({ ...channel('25'), source: null, onAir: false, statusText: '20:30 계속예정' });
  await settle(); await settle();
  assert.equal($('audio-toggle').disabled, false, '자막 주소와 ON AIR 표시 없이 미디어 주소만으로 재생할 수 있다');
  assert.equal($('video-toggle').checked, true);
  controller.setSource(channel('25')); await settle(); await settle();
  assert.equal($('video-toggle').disabled, false);
  assert.equal($('video-toggle').checked, true);
  assert.equal($('broadcast-video').paused, false);
  assert.equal($('broadcast-audio').paused, true);
  const previous = players.findLast(player => player.media === $('broadcast-video'));
  controller.setSource({ ...channel('25'), onAir: false, statusText: '감사중지' }); await settle();
  assert.equal($('broadcast-video').paused, false, '상태가 바뀌어도 주소가 있으면 계속 재생한다');
  controller.setSource({ ...channel('25'), onAir: false, statusText: '감사중지', audioUrl: '' }); await settle();
  assert.equal($('broadcast-video').paused, true);
  assert.equal($('video-toggle').disabled, true);
  assert.equal($('audio-toggle').disabled, true);
  assert.equal(previous.destroyed, true);
  assert.equal(saved.get('assembly-caption-video-enabled'), 'true');
  controller.setSource(channel('25')); await settle(); await settle();
  assert.equal($('broadcast-video').paused, false);
  assert.equal($('broadcast-audio').playCalls, 0);
  $('audio-toggle').checked = true; await $('audio-toggle').onchange(); await settle();
  assert.equal(saved.get('assembly-caption-video-enabled'), 'false', '오디오로 전환하면 영상 자동 복원 선택을 해제한다');
  controller.setSource({ ...channel('25'), onAir: false, statusText: '감사종료' });
  assert.equal($('broadcast-audio').paused, false, 'ON AIR 종료만으로 미디어를 끊지 않는다');
  controller.setSource({ ...channel('25'), onAir: false, statusText: '감사종료', audioUrl: '' });
  assert.equal($('broadcast-audio').paused, true);
  controller.setSource(channel('25')); await settle();
  assert.equal($('audio-toggle').checked, false, '방송이 재개되어도 오디오는 자동으로 켜지지 않는다');
  assert.equal($('video-toggle').checked, false);
});

for (const safari of [false, true]) {
test(`${safari ? '기본 HLS' : 'HLS.js'}: 모드를 바꾸면 이전 버퍼·주소를 비우고 새 재생기로 돌아온다`, async t => {
  const { $, controller, players } = setup(t, { safari });
  controller.setSource(channel('19')); await settle();
  $('audio-toggle').checked = true; await $('audio-toggle').onchange();
  const firstAudio = players.findLast(player => player.media === $('broadcast-audio'));
  assert.equal($('broadcast-audio').buffered.length, 1);
  await startVideo($);
  assert.equal($('broadcast-audio').buffered.length, 0);
  assert.equal($('broadcast-audio').src, '');
  if (firstAudio) assert.equal(firstAudio.destroyed, true);
  const videoPlayer = players.findLast(player => player.media === $('broadcast-video'));
  assert.equal($('broadcast-video').buffered.length, 1);
  const playCalls = $('broadcast-audio').playCalls;
  $('audio-toggle').checked = true; const playing = $('audio-toggle').onchange();
  assert.equal($('broadcast-audio').playCalls, playCalls + 1, '재생기 재생성 후에도 사용자 입력 안에서 play를 호출한다');
  await playing; await settle();
  assert.equal($('broadcast-video').buffered.length, 0);
  assert.equal($('broadcast-video').src, '');
  if (videoPlayer) assert.equal(videoPlayer.destroyed, true);
  assert.equal(players.filter(player => player.media === $('broadcast-video') && !player.destroyed).length, 0, '정리한 영상 연결을 백그라운드에서 다시 만들지 않는다');
  if (firstAudio) assert.notEqual(players.findLast(player => player.media === $('broadcast-audio')), firstAudio);
  assert.equal($('broadcast-audio').paused, false);
});
}

test('모바일 전체화면에서 가로 방향을 요청하고 종료·오디오 전환 시 해제한다', async t => {
  const { $, controller, window, document, docEvents } = setup(t, { mobile: true });
  const requests = [];
  window.screen = { orientation: { async lock(value) { requests.push(value); }, unlock() { requests.push('unlock'); } } };
  controller.setSource(channel('19')); await settle(); await startVideo($);
  await $('fullscreen-toggle').onclick();
  assert.deepEqual(requests, ['landscape']);
  document.fullscreenElement = null; docEvents.fullscreenchange();
  assert.deepEqual(requests, ['landscape', 'unlock']);
  assert.equal($('media-shell').classList.contains('landscape-fallback'), false);
  await $('fullscreen-toggle').onclick();
  $('audio-toggle').checked = true; await $('audio-toggle').onchange();
  assert.deepEqual(requests, ['landscape', 'unlock', 'landscape', 'unlock']);
});

test('모바일에서 전체화면·방향 고정이 거절되면 가로 확대 보기로 유지한다', async t => {
  const { $, controller, window, docEvents } = setup(t, { mobile: true });
  window.screen = { orientation: { async lock() { throw Error('unsupported'); } } };
  $('media-shell').requestFullscreen = async () => { throw Error('unavailable'); };
  controller.setSource(channel('19')); await settle(); await startVideo($);
  await $('fullscreen-toggle').onclick();
  assert.equal($('media-shell').classList.contains('is-expanded'), true);
  assert.equal($('media-shell').classList.contains('landscape-fallback'), true);
  assert.equal($('broadcast-video').paused, false);
  docEvents.keydown({ key: 'Escape' });
  assert.equal($('media-shell').classList.contains('landscape-fallback'), false);
});

test('방향 고정 API가 없는 iPhone도 가로 보기 대체 방식을 사용한다', async t => {
  const { $, controller } = setup(t, { safari: true, mobile: true });
  controller.setSource(channel('19')); await settle(); await startVideo($);
  await $('fullscreen-toggle').onclick();
  assert.equal($('media-shell').classList.contains('landscape-fallback'), true);
  await $('fullscreen-exit').onclick();
  assert.equal($('media-shell').classList.contains('landscape-fallback'), false);
});

test('전체화면 종료 뒤 늦게 완료된 방향 고정 요청도 해제한다', async t => {
  const { $, controller, window } = setup(t, { mobile: true });
  let finish, locked = false;
  window.screen = { orientation: {
    lock() { return new Promise(resolve => { finish = () => { locked = true; resolve(); }; }); },
    unlock() { locked = false; },
  } };
  controller.setSource(channel('19')); await settle(); await startVideo($);
  const entering = $('fullscreen-toggle').onclick(); await settle();
  await $('fullscreen-exit').onclick(); finish(); await entering;
  assert.equal(locked, false);
  assert.equal($('media-shell').classList.contains('landscape-fallback'), false);
});
