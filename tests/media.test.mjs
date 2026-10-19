import test from 'node:test';
import assert from 'node:assert/strict';
import { initMedia } from '../media.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
function startVideo($) { $('video-toggle').checked = true; return $('video-toggle').onchange(); }
const channel = id => ({ id, name: `위원회 ${id}`, onAir: true,
  source: `wss://captions.test/${id}`,
  audioUrl: `https://w-assembly.hscdn.com/assembly/${id}_240p/playlist.m3u8`,
  videoDefaultUrl: `https://w-assembly.hscdn.com/assembly/${id}_480p/playlist.m3u8`,
  videoSources: [240, 480, 720, 1080].map(height => ({ height,
    url: `https://w-assembly.hscdn.com/assembly/${id}_${height}p/playlist.m3u8` })),
});

function setup(t, { safari = false, delayed = false, mobile = false, restoredPip = false, savedEntries = [], initialQuality } = {}) {
  const nodes = {}, players = [], scripts = [], docEvents = {}, winEvents = {}, originals = new Map(), saved = new Map(savedEntries);
  const timers = new Map();
  let nextTimer = 1;
  const element = () => {
    const classes = new Set(), events = {};
    return { value: '', textContent: '', hidden: false, disabled: false, checked: false, children: [], attributes: {},
      src: '', buffered: { length: 0 }, readyState: 2, paused: true, muted: false, seekable: { length: 0 }, scrollHeight: 300, clientHeight: 100, scrollTop: 200,
      classList: { contains: value => classes.has(value), add: value => classes.add(value), remove: value => classes.delete(value),
        toggle(value, force) { if (force ?? !classes.has(value)) classes.add(value); else classes.delete(value); } },
      contains() { return false; },
      setAttribute(key, value) { this.attributes[key] = value; },
      querySelector(selector) { return this.children.find(child => child.value === 'auto'); },
      replaceCalls: 0, replaceChildren(...children) { this.replaceCalls++; this.children = children; },
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
    static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifest', LEVEL_SWITCHED: 'level', LEVEL_SWITCHING: 'switching', LEVEL_LOADED: 'loaded' };
    static isSupported() { return true; }
    levels = []; _currentLevel = -1; loadLevel = -1; listeners = {}; immediateSwitches = [];
    get currentLevel() { return this._currentLevel; }
    set currentLevel(level) {
      this._currentLevel = level; this.loadLevel = level;
      this.immediateSwitches.push(level);
      this.listeners.switching?.(null, { level });
      this.media.buffered.length = 0;
    }
    latencyOverrides = 0;
    constructor(options) {
      this.options = options;
      Object.defineProperty(this, 'targetLatency', { set: () => { this.latencyOverrides++; } });
      players.push(this);
    }
    on(name, fn) { this.listeners[name] = fn; }
    attachMedia(media) { this.media = media; media.src = `blob:player-${players.length}`; }
    loadSource(url) { this.url = url; queueMicrotask(() => {
      if (this.destroyed) return;
      const height = Number(url.match(/_(\d+)p\//)?.[1]);
      this.levels = (height ? [height] : [240, 480, 720, 1080]).map(height => ({ height })); this.listeners.manifest?.();
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
    setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    addEventListener(name, fn) { winEvents[name] = fn; } };
  const fetchRequests = [];
  const fetch = async url => { fetchRequests.push(url); throw Error('unexpected application fetch'); };
  for (const [name, value] of Object.entries({ document, window, fetch, navigator: { userAgent: mobile ? (safari ? 'iPhone Version/18 Safari' : 'Android Chrome') : safari ? 'Version/18 Safari' : 'Chrome' } })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  t.after(() => { for (const [name, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]; });
  const controller = initMedia($);
  if (initialQuality) { $('video-quality').value = initialQuality; $('video-quality').onchange(); }
  return { $, controller, players, document, window, scripts, Hls, docEvents, winEvents, saved, fetchRequests, timers };
}

test('오디오↔영상 전환은 하나만 재생하고 240p 시작·자동 및 직접 화질을 제공한다', async t => {
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
  assert.match(videoPlayer.url, /\/api\/video.m3u8\?channel=19&_/);
  assert.equal($('video-quality').value, 'auto');
  assert.equal(videoPlayer.loadLevel, -1, '초기 화질을 고정하지 않고 자동 상승을 허용한다');
  $('video-quality').value = '720'; await $('video-quality').onchange(); await settle();
  assert.equal(videoPlayer.destroyed, true);
  assert.match(players.at(-1).url, /19_720p/);
  $('fullscreen-quality').value = 'auto'; await $('fullscreen-quality').onchange(); await settle();
  const autoPlayer = players.at(-1);
  assert.match(autoPlayer.url, /\/api\/video.m3u8\?channel=19&_/);
  assert.equal(autoPlayer.options.startLevel, 0, '자동 화질로 돌아오면 240p부터 시작한다');
  assert.equal(autoPlayer.loadLevel, -1);
  const connection = autoPlayer.url, playerCount = players.length;
  autoPlayer.listeners.level(null, { level: 3 });
  assert.equal($('video-quality').children[0].textContent, '자동 · 1080p');
  assert.equal(autoPlayer.latencyOverrides, 0, '자동 화질 전환에서 지연값을 따로 조절하지 않는다');
  assert.equal(autoPlayer.url, connection); assert.equal(players.length, playerCount, '자동 화질 전환은 연결을 새로 만들지 않는다');
  assert.equal($('broadcast-video').paused, false);
  $('audio-toggle').checked = true; await $('audio-toggle').onchange();
  assert.equal($('broadcast-video').paused, true); assert.equal($('media-panel').hidden, true);
  assert.equal($('broadcast-audio').paused, false); assert.equal(autoPlayer.loading, false);
  assert.equal($('video-toggle').checked, false);
  assert.equal($('video-options').hidden, true, '오디오로 전환하면 영상 옵션을 접는다');
  await startVideo($);
  $('video-toggle').checked = false; $('video-toggle').onchange();
  assert.equal($('broadcast-video').paused, true);
  assert.equal($('media-panel').hidden, true);
  assert.equal($('video-options').hidden, true, '영상 스위치를 끄면 영상과 옵션을 함께 접는다');
});

test('자동 상향 전환은 버퍼를 한 번 비우고 자동 화질을 유지한다', async t => {
  const { $, controller, players } = setup(t);
  controller.setSource(channel('26')); await settle(); await startVideo($);
  const video = $('broadcast-video'), player = players.at(-1);
  const switches = level => player.listeners.switching(null, { level });
  switches(0); await settle();
  assert.deepEqual(player.immediateSwitches, [], '초기 240p 선택에서는 비우지 않는다');
  switches(3); switches(3); await settle();
  assert.deepEqual(player.immediateSwitches, [3], '1080p 상향의 중복 요청은 한 번만 처리한다');
  assert.equal(video.buffered.length, 0);
  assert.equal(player.loadLevel, -1, '즉시 전환 후에도 자동 화질을 유지한다');
  assert.equal(player.nextAutoLevel, 3, '다음 구간만 ABR이 고른 상향 화질로 요청한다');
  assert.equal($('video-quality').value, 'auto');
  assert.equal(video.paused, false);
  assert.equal(video.muted, false);
  assert.equal(player.latencyOverrides, 0);
  video.buffered.length = 1;
  switches(2); await settle();
  assert.deepEqual(player.immediateSwitches, [3], '하향 전환은 재생기 기본 동작을 따른다');
  switches(3); await settle();
  assert.deepEqual(player.immediateSwitches, [3, 3], '다음 상향은 새로 한 번 처리한다');
});

test('철회된 상향이나 일시정지·빈 버퍼에서는 추가로 버퍼를 비우지 않는다', async t => {
  const { $, controller, players } = setup(t);
  controller.setSource(channel('26')); await settle(); await startVideo($);
  const video = $('broadcast-video'), player = players.at(-1);
  const switches = level => player.listeners.switching(null, { level });
  switches(0); switches(3); switches(0); await settle();
  assert.deepEqual(player.immediateSwitches, [], '이미 취소된 상향 요청을 실행하지 않는다');
  video.pause(); switches(3); await settle();
  assert.deepEqual(player.immediateSwitches, []);
  await startVideo($);
  switches(0); video.buffered.length = 0; switches(3); await settle();
  assert.deepEqual(player.immediateSwitches, []);
});

test('상향 예약 직후 채널이나 수동 화질을 바꾸면 이전 버퍼 작업을 취소한다', async t => {
  const { $, controller, players } = setup(t);
  controller.setSource(channel('26')); await settle(); await startVideo($);
  const old = players.at(-1);
  old.listeners.switching(null, { level: 0 }); old.listeners.switching(null, { level: 3 });
  controller.setSource(channel('25')); await settle(); await settle();
  assert.equal(old.destroyed, true); assert.deepEqual(old.immediateSwitches, []);
  old.listeners.switching(null, { level: 3 });
  const current = players.at(-1);
  current.listeners.switching(null, { level: 0 }); current.listeners.switching(null, { level: 3 });
  $('video-quality').value = '1080'; await $('video-quality').onchange(); await settle();
  assert.equal(current.destroyed, true); assert.deepEqual(current.immediateSwitches, []);
  const fixed = players.at(-1);
  fixed.listeners.switching(null, { level: 0 }); await settle();
  assert.deepEqual(fixed.immediateSwitches, []);
  assert.equal(fixed.loadLevel, 0);
  assert.match(fixed.url, /25_1080p/);
});

for (const safari of [false, true]) {
test(`${safari ? 'Safari' : 'HLS.js'}: 영상도 오디오처럼 마지막 재생 범위 끝의 2초 전에서 시작한다`, async t => {
  const { $, controller, players, fetchRequests } = setup(t, { safari });
  const video = $('broadcast-video');
  const seekWrites = [];
  let rateWrites = 0;
  Object.defineProperty(video, 'currentTime', { get: () => 37, set: value => { seekWrites.push(value); } });
  Object.defineProperty(video, 'playbackRate', { get: () => 1, set: () => { rateWrites++; } });
  video.seekable = { length: 2, start: index => index ? 80 : 0, end: index => index ? 100 : 20 };
  controller.setSource(channel('19')); await settle(); await startVideo($);
  assert.deepEqual(seekWrites, [98], '여러 범위 중 마지막 범위를 기준으로 재생한다');
  for (const name of ['loadedmetadata', 'loadeddata', 'durationchange', 'progress', 'canplay']) video.emit(name);
  assert.deepEqual(seekWrites, [98], '진행 이벤트마다 위치를 다시 움직이지 않는다');
  $('video-quality').value = '1080'; await $('video-quality').onchange(); await settle();
  assert.deepEqual(seekWrites, [98, 98], '수동 화질을 새로 재생할 때도 같은 기준을 적용한다');
  for (const name of ['loadedmetadata', 'loadeddata', 'durationchange', 'progress', 'canplay']) video.emit(name);
  video.pause();
  video.seekable = { length: 1, start: () => 99, end: () => 100 };
  await startVideo($);
  assert.equal(video.paused, false);
  assert.deepEqual(seekWrites, [98, 98, 99], '재개 시 범위가 2초보다 짧으면 범위 시작점으로 제한한다');
  video.pause(); video.seekable = { length: 0 };
  await startVideo($);
  assert.equal(video.paused, false);
  assert.deepEqual(seekWrites, [98, 98, 99], '범위가 아직 없으면 오디오처럼 위치 이동 없이 재생한다');
  assert.equal(rateWrites, 0);
  assert.deepEqual(fetchRequests, [], '별도 타이밍 계산용 목록을 요청하지 않는다');
  for (const player of players.filter(item => item.media === video)) {
    assert.equal(player.latencyOverrides, 0);
    for (const key of ['liveSyncDuration', 'liveSyncDurationCount', 'liveMaxLatencyDuration', 'liveMaxLatencyDurationCount', 'maxLiveSyncPlaybackRate']) {
      assert.equal(Object.hasOwn(player.options, key), false, key);
    }
  }
});
}

test('초기 채널이 비어 있어도 나중에 확인한 채널을 240p 자동 화질로 시작한다', async t => {
  const { $, controller, players } = setup(t);
  controller.setSource(null);
  const next = channel('19');
  next.videoDefaultUrl = next.videoSources.find(source => source.height === 720).url;
  controller.setSource(next); await settle(); await startVideo($);
  assert.equal($('video-quality').value, 'auto');
  assert.match(players.at(-1).url, /\/api\/video.m3u8\?channel=19&_/);
  assert.equal(players.at(-1).options.startLevel, 0);
  assert.equal(players.at(-1).loadLevel, -1);
});

test('전체화면 자막·분할·PIP 전환을 처리하고 오디오 전환 시 모두 종료한다', async t => {
  const { $, controller, document } = setup(t);
  controller.setSource(channel('19')); await settle(); await startVideo($);
  controller.setCaptions([{ id: 1, text: '<script>자막은 텍스트</script>' }, { id: 2, text: '최신 발언' }]);
  assert.match($('caption-overlay-text').textContent, /최신 발언/);
  assert.equal($('fullscreen-history').children.length, 0, '숨겨진 전체화면 목록은 만들지 않는다');
  await $('fullscreen-toggle').onclick(); assert.equal(document.fullscreenElement, $('media-shell'));
  $('caption-layout').value = 'split'; $('caption-layout').onchange();
  assert.equal($('media-shell').classList.contains('caption-layout-split'), true);
  assert.equal($('fullscreen-history').children[0].textContent, '<script>자막은 텍스트</script>');
  await $('pip-toggle').onclick(); assert.equal(document.fullscreenElement, null);
  assert.equal(document.pictureInPictureElement, $('broadcast-video'));
  await $('fullscreen-toggle').onclick(); assert.equal(document.pictureInPictureElement, null);
  $('audio-toggle').checked = true; await $('audio-toggle').onchange();
  assert.equal(document.fullscreenElement, null); assert.equal($('media-panel').hidden, true);
  controller.setCaptions([], { live: false }); assert.match($('caption-overlay-text').textContent, /오늘 날짜/);
});

test('긴 자막 기록에서도 최근 항목만 읽고 보이는 분할 목록의 수정 항목만 갱신한다', async t => {
  const { $, controller } = setup(t);
  controller.setSource(channel('26')); await settle(); await startVideo($);
  let textReads = 0;
  const rows = Array.from({ length: 20000 }, (_, id) => ({ id, get text() { textReads++; return `발언 ${id}`; } }));
  controller.setCaptions(rows);
  assert.ok(textReads < 500, `최근 자막 조회 횟수: ${textReads}`);
  assert.equal($('fullscreen-history').children.length, 0);
  await $('fullscreen-toggle').onclick();
  assert.equal($('fullscreen-history').children.length, 0, '겹침 모드에서도 숨겨진 분할 목록은 만들지 않는다');
  $('caption-layout').value = 'split'; $('caption-layout').onchange();
  const history = $('fullscreen-history');
  assert.equal(history.children.length, 100);
  assert.equal(history.children[0].textContent, '발언 19900');
  const last = history.children.at(-1), replacements = history.replaceCalls;
  $('fullscreen-captions').scrollTop = 0;
  rows[19999] = { id: 19999, text: '최신 발언 수정' }; controller.setCaptions(rows);
  assert.equal(history.children.at(-1), last);
  assert.equal(last.textContent, '최신 발언 수정');
  assert.equal(history.replaceCalls, replacements, '기존 문장 수정 시 전체 목록을 교체하지 않는다');
  assert.equal($('fullscreen-captions').scrollTop, 0, '이전 발언을 읽는 위치를 유지한다');
  await $('fullscreen-exit').onclick();
  rows[19999] = { id: 19999, text: '숨긴 동안 수정' }; controller.setCaptions(rows);
  assert.equal(last.textContent, '최신 발언 수정');
  await $('fullscreen-toggle').onclick();
  assert.equal(last.textContent, '숨긴 동안 수정', '분할 보기에 다시 들어가면 최신 내용으로 갱신한다');
});

test('전체화면 터치 후 남은 포커스는 자동 숨김을 막지 않고 키보드 포커스는 보호한다', async t => {
  const { $, controller, document, timers } = setup(t, { mobile: true });
  controller.setSource(channel('26')); await settle(); await startVideo($);
  await $('fullscreen-toggle').onclick();
  const shell = $('media-shell');
  shell.contains = node => node === $('fullscreen-quality');
  document.activeElement = $('fullscreen-quality');
  const idle = () => { const callbacks = [...timers.values()]; timers.clear(); for (const fn of callbacks) fn(); };
  shell.emit('touchstart'); shell.emit('focusin'); idle();
  assert.equal(shell.classList.contains('controls-hidden'), true, '터치 선택 후 포커스를 옮기지 않아도 숨긴다');
  shell.emit('keydown'); idle();
  assert.equal(shell.classList.contains('controls-hidden'), false, '키보드로 도구를 조작할 때는 계속 표시한다');
  document.activeElement = null; shell.emit('focusout'); idle();
  assert.equal(shell.classList.contains('controls-hidden'), true, '키보드 포커스가 떠나면 다시 숨긴다');
  shell.emit('pointerdown');
  document.activeElement = $('fullscreen-quality'); idle();
  assert.equal(shell.classList.contains('controls-hidden'), true, '마우스 사용도 남은 포커스와 무관하게 숨긴다');
  $('broadcast-video').pause(); idle();
  assert.equal(shell.classList.contains('controls-hidden'), false, '일시정지 중에는 도구를 숨기지 않는다');
  await startVideo($);
  await $('fullscreen-exit').onclick(); idle();
  assert.equal(shell.classList.contains('controls-hidden'), false, '전체화면을 나가면 숨김 예약을 취소한다');
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
  assert.ok(players.find(player => /\/api\/video.m3u8\?channel=25&_/.test(player.url)));
  await $('pip-toggle').onclick(); controller.setSource(null);
  assert.equal($('broadcast-video').paused, true); assert.equal(document.pictureInPictureElement, null);
  assert.equal($('media-panel').hidden, true); assert.equal($('video-toggle').disabled, true);
});

test('Safari는 기본 HLS로 재생하고 수동 화질과 자동 목록을 전환한다', async t => {
  const { $, controller, players } = setup(t, { safari: true });
  controller.setSource(channel('19')); await settle(); await startVideo($);
  assert.equal(players.length, 0); assert.match($('broadcast-video').src, /\/api\/video.m3u8\?channel=19&_/);
  $('video-quality').value = '1080'; await $('video-quality').onchange();
  assert.match($('broadcast-video').src, /19_1080p/); assert.equal($('broadcast-video').paused, false);
  $('video-quality').value = 'auto'; await $('video-quality').onchange(); assert.match($('broadcast-video').src, /\/api\/video.m3u8\?channel=19&_/);
  controller.setSource(channel('25')); await settle(); await settle();
  assert.match($('broadcast-video').src, /\/api\/video.m3u8\?channel=25&_/);
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
test(`${safari ? 'Safari' : 'HLS.js'}: 자동 재생 차단 시 영상과 컨트롤을 접고 소리 설정을 유지해 직접 재생할 수 있다`, async t => {
  const { $, controller, saved, document, players } = setup(t, { safari, savedEntries: [
    ['assembly-caption-video-enabled', 'true'], ['assembly-caption-audio-enabled', 'true'],
    ['assembly-caption-video-muted', 'false'],
  ] });
  let allowPlayback = false;
  const video = $('broadcast-video'), originalPlay = video.play, mutedAttempts = [];
  video.play = function () {
    mutedAttempts.push(this.muted);
    if (!allowPlayback) return Promise.reject(Object.assign(Error('blocked'), { name: 'NotAllowedError' }));
    return originalPlay.call(this);
  };
  controller.setSource(channel('25')); await settle(); await settle();
  assert.deepEqual(mutedAttempts, [false], '사용자의 소리 선택을 바꾸는 음소거 재시도를 하지 않는다');
  assert.equal(video.paused, true); assert.equal(video.muted, false);
  assert.equal(saved.get('assembly-caption-video-muted'), 'false');
  assert.equal(saved.get('assembly-caption-video-enabled'), 'false');
  assert.equal($('video-toggle').checked, false);
  assert.equal($('media-panel').hidden, true);
  assert.equal($('video-options').hidden, true);
  for (const id of ['video-quality', 'fullscreen-quality', 'video-sound', 'fullscreen-sound', 'fullscreen-toggle', 'pip-toggle']) {
    assert.equal($(id).disabled, true, id);
  }
  assert.equal(video.src, '');
  assert.ok(players.filter(player => player.media === video).every(player => player.destroyed));
  assert.equal($('audio-toggle').checked, false); assert.equal($('broadcast-audio').playCalls, 0);
  assert.equal(saved.has('assembly-caption-audio-enabled'), false);
  assert.match($('media-status').textContent, /소리 있는 자동 재생이 차단/);
  assert.equal($('video-sound').textContent, '음소거');
  assert.equal($('fullscreen-sound').textContent, '음소거');
  assert.equal(document.pictureInPictureElement, null);
  controller.setSource(channel('25')); await settle();
  assert.deepEqual(mutedAttempts, [false], '채널 정보 갱신으로 자동 재생을 재시도하지 않는다');
  allowPlayback = true; await startVideo($);
  assert.deepEqual(mutedAttempts, [false, false]);
  assert.equal(video.paused, false); assert.equal(video.muted, false);
  assert.equal($('video-toggle').checked, true);
  assert.equal($('media-panel').hidden, false);
  assert.equal($('video-options').hidden, false);
  assert.equal(saved.get('assembly-caption-video-enabled'), 'true');
  $('video-sound').onclick();
  assert.equal(video.muted, true); assert.equal($('video-sound').textContent, '소리 켜기');
  assert.equal(saved.get('assembly-caption-video-muted'), 'true');
  $('fullscreen-sound').onclick(); assert.equal(video.muted, false);
  assert.equal(saved.get('assembly-caption-video-muted'), 'false');
  $('video-toggle').checked = false; $('video-toggle').onchange();
  assert.equal(saved.get('assembly-caption-video-enabled'), 'false');
});
}

for (const safari of [false, true]) {
for (const muted of [false, true]) {
test(`${safari ? 'Safari' : 'HLS.js'}: ${muted ? '음소거' : '소리 켬'}으로 재생 중 새로고침하면 같은 음소거 선택으로 자동 재생한다`, async t => {
  const { $, controller, saved, winEvents, document } = setup(t, { safari });
  const video = $('broadcast-video');
  controller.setSource(channel('25')); await settle(); await startVideo($);
  video.muted = muted; video.emit('volumechange');
  assert.equal(saved.get('assembly-caption-video-muted'), String(muted));
  winEvents.pagehide();
  assert.equal(saved.get('assembly-caption-video-enabled'), 'true');
  assert.equal(video.paused, true);
  // A fresh media controller reads the saved choices rather than the old element state.
  video.muted = !muted;
  const calls = video.playCalls;
  const restored = initMedia($);
  restored.setSource(channel('25')); await settle(); await settle();
  assert.equal(video.muted, muted);
  assert.equal(video.paused, false);
  assert.equal(video.playCalls, calls + 1);
  assert.equal($('video-toggle').checked, true);
  assert.equal($('video-sound').textContent, muted ? '소리 켜기' : '음소거');
  assert.equal($('audio-toggle').checked, false);
  assert.equal($('broadcast-audio').playCalls, 0);
  assert.equal(document.pictureInPictureElement, null);
});
}
}

test('음소거를 기억해도 꺼둔 영상은 새로고침 후 자동 재생하지 않는다', async t => {
  const { $, controller } = setup(t, { savedEntries: [
    ['assembly-caption-video-enabled', 'false'], ['assembly-caption-video-muted', 'true'],
  ] });
  controller.setSource(channel('25')); await settle();
  assert.equal($('broadcast-video').muted, true);
  assert.equal($('broadcast-video').playCalls, 0);
  assert.equal($('video-toggle').checked, false);
});

test('음소거 자동 재생이 차단되면 음소거 선택을 유지하고 수동 재생을 안내한다', async t => {
  const { $, controller, players, saved } = setup(t, { savedEntries: [
    ['assembly-caption-video-enabled', 'true'], ['assembly-caption-video-muted', 'true'],
  ] });
  const attempts = [];
  $('broadcast-video').play = function () {
    attempts.push(this.muted); return Promise.reject(Object.assign(Error('blocked'), { name: 'NotAllowedError' }));
  };
  controller.setSource(channel('25')); await settle(); await settle();
  assert.deepEqual(attempts, [true]);
  assert.equal($('broadcast-video').muted, true);
  assert.equal(saved.get('assembly-caption-video-muted'), 'true');
  assert.equal(saved.get('assembly-caption-video-enabled'), 'false');
  assert.equal($('video-toggle').checked, false);
  assert.equal($('media-panel').hidden, true);
  assert.equal($('video-options').hidden, true);
  assert.equal($('audio-toggle').checked, false);
  assert.equal($('pip-toggle').disabled, true);
  assert.match($('media-status').textContent, /재생이 차단/);
  assert.equal(players.findLast(player => player.media === $('broadcast-video')).loading, false);
  assert.equal(players.findLast(player => player.media === $('broadcast-video')).destroyed, true);
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
