import test from 'node:test';
import assert from 'node:assert/strict';
import { initAudio } from '../audio.mjs';

test('Android Edge에서는 HLS.js를 준비하고 스위치 입력 안에서 즉시 직접 오디오 재생한다', async t => {
  const nodes = {}, players = [], handlers = {};
  const saved = new Map();
  const original = new Map();
  const audio = { src: '', seekable: { length: 0 }, listeners: {}, playCalls: 0,
    canPlayType() { return 'maybe'; }, pause() {}, load() {}, removeAttribute() {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    play() { this.playCalls++; return Promise.resolve(); },
  };
  const $ = id => nodes[id] ??= { value: '', textContent: '', disabled: false, checked: false, setAttribute() {} };
  nodes['broadcast-audio'] = audio;
  $('audio-url').value = 'https://original-broadcast.test/live.m3u8';
  class Hls {
    static isSupported() { return true; }
    static Events = { ERROR: 'error' };
    constructor(options) { this.options = options; players.push(this); }
    levels = [];
    on() {} attachMedia(media) { this.media = media; }
    loadSource(source) { this.source = source; }
    startLoad() { this.started = true; } stopLoad() { this.stopped = true; } destroy() {}
  }
  const values = { window: { Hls, localStorage: { getItem(key) { return saved.get(key) ?? null; }, setItem(key, value) { saved.set(key, value); } } }, navigator: { userAgent: 'Android EdgA/140 Chrome',
    mediaSession: { setActionHandler(action, fn) { handlers[action] = fn; } } },
    document: { createElement() { throw Error('Should not load another library'); } },
  };
  for (const [name, value] of Object.entries(values)) {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  t.after(() => { for (const [name, descriptor] of original) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]; });
  const controller = initAudio($); await new Promise(resolve => setImmediate(resolve));
  assert.equal(players.length, 1); assert.equal(players[0].options.autoStartLoad, false);
  assert.equal(players[0].source, 'https://original-broadcast.test/live.m3u8');
  $('audio-toggle').checked = true;
  const playing = $('audio-toggle').onchange();
  assert.equal(audio.playCalls, 1, 'play called before awaiting a network or library load'); await playing;
  assert.equal(saved.has('assembly-caption-audio-enabled'), false);
  assert.equal($('audio-status').textContent, '오디오 재생 중');
  handlers.pause(); assert.equal(players[0].stopped, true);
  assert.equal($('audio-toggle').checked, false);
  assert.equal(saved.has('assembly-caption-audio-enabled'), false);
  await handlers.play(); assert.equal(audio.playCalls, 2);
  controller.setSource('https://original-broadcast.test/second.m3u8');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal($('audio-toggle').checked, true, '채널 변경 뒤에도 켜진 상태를 유지한다');
  assert.equal(audio.playCalls, 3, '변경된 채널의 오디오 재생을 이어간다');
  assert.equal(players.at(-1).source, 'https://original-broadcast.test/second.m3u8');
  audio.paused = true; audio.listeners.pause();
  assert.equal($('audio-toggle').checked, false, '브라우저가 오디오를 중지하면 스위치도 꺼진다');
  controller.setSource('https://original-broadcast.test/third.m3u8');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(audio.playCalls, 3, '외부 중지 뒤에는 채널을 바꿔도 오디오를 자동 시작하지 않는다');
});

test('이전 오디오 켬 상태와 복원된 스위치가 있어도 새 페이지는 꺼진 상태로 시작한다', async t => {
  const nodes = {}, original = new Map(), saved = new Map([['assembly-caption-audio-enabled', 'true']]);
  const audio = { src: '', seekable: { length: 0 }, playCalls: 0,
    canPlayType() { return 'maybe'; }, pause() {}, load() {}, removeAttribute() {}, addEventListener() {},
    play() { this.playCalls++; return Promise.resolve(); } };
  const $ = id => nodes[id] ??= { value: '', textContent: '', disabled: false, checked: false };
  nodes['broadcast-audio'] = audio;
  $('audio-url').value = 'https://original-broadcast.test/live.m3u8';
  $('audio-toggle').checked = true;
  const values = {
    window: { localStorage: { getItem(key) { return saved.get(key) ?? null; }, setItem(key, value) { saved.set(key, value); }, removeItem(key) { saved.delete(key); } } },
    navigator: { userAgent: 'Version/18.0 Safari/605.1.15' },
  };
  for (const [name, value] of Object.entries(values)) {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  t.after(() => { for (const [name, descriptor] of original) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]; });
  initAudio($); await new Promise(resolve => setImmediate(resolve));
  assert.equal($('audio-toggle').checked, false);
  assert.equal(audio.playCalls, 0, '저장된 켬 상태로 자동 재생하지 않는다');
  assert.equal(saved.has('assembly-caption-audio-enabled'), false);
  assert.equal($('audio-status').textContent, '오디오 대기');
});

function blockedHls(t, userAgent) {
  const nodes = {}, players = [], original = new Map();
  const saved = new Map([['assembly-caption-audio-enabled', 'true']]);
  const $ = id => nodes[id] ??= { value: '', textContent: '', disabled: false, checked: false };
  let gesture = false, finishPlayback;
  const audio = { seekable: { length: 0 }, paused: true, listeners: {}, playGestures: [],
    canPlayType() { return 'maybe'; }, load() {}, removeAttribute() {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    pause() { this.paused = true; },
    play() {
      this.playGestures.push(gesture);
      if (!gesture) return Promise.reject(Object.assign(Error('Autoplay blocked'), { name: 'NotAllowedError' }));
      this.paused = false;
      if (players.at(-1).levels.length) return Promise.resolve();
      return new Promise(resolve => { finishPlayback = resolve; });
    },
  };
  class Hls {
    static Events = { ERROR: 'error' };
    static isSupported() { return true; }
    levels = []; loadingManifest = false; sourceLoads = 0;
    constructor() { players.push(this); }
    on() {} attachMedia() {} destroy() {}
    loadSource() { this.sourceLoads++; this.loadingManifest = true; this.levels = []; }
    startLoad() {} // HLS startLoad does not restart an aborted initial manifest request.
    stopLoad() { this.loadingManifest = false; }
    finishManifest() {
      if (!this.loadingManifest) return false;
      this.loadingManifest = false; this.levels = [{}]; finishPlayback?.(); return true;
    }
  }
  nodes['broadcast-audio'] = audio;
  $('audio-url').value = 'https://original-broadcast.test/live.m3u8';
  const values = {
    window: { Hls, localStorage: {
      getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value),
    } },
    navigator: { userAgent },
  };
  for (const [name, value] of Object.entries(values)) {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  const controller = initAudio($);
  return { $, audio, players, saved, controller,
    toggle(checked) {
      $('audio-toggle').checked = checked; gesture = true;
      try { return $('audio-toggle').onchange(); } finally { gesture = false; }
    },
  };
}

for (const [browser, userAgent] of [
  ['Android Edge', 'Android EdgA/140 Chrome'], ['Android Chrome', 'Android Chrome/140'],
]) {
test(`${browser}: 새 페이지는 자동 재생하지 않고 수동 재생 차단 후 지연된 pause가 안내를 덮지 않는다`, async t => {
  const { $, audio, controller } = blockedHls(t, userAgent);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(audio.playGestures, [], '이전 켬 상태가 있어도 자동 재생을 시도하지 않는다');
  await controller.play();
  assert.equal($('audio-toggle').checked, false);
  assert.match($('audio-status').textContent, /자동 재생 차단됨/);
  audio.listeners.pause();
  assert.match($('audio-status').textContent, /자동 재생 차단됨/);
});

test(`${browser}: 자동재생 차단으로 초기 HLS 목록이 취소되어도 스위치 입력 안에서 재요청하고 재생한다`, async t => {
  const { $, audio, players, toggle, controller } = blockedHls(t, userAgent);
  await new Promise(resolve => setImmediate(resolve));
  await controller.play();
  assert.equal(players[0].loadingManifest, false);
  const playing = toggle(true);
  assert.deepEqual(audio.playGestures, [false, true], '수동 재생은 비동기 준비를 기다리지 않고 사용자 입력 안에서 호출한다');
  assert.equal(players.length, 1, '기존 미디어 연결을 유지한다');
  assert.equal(players[0].finishManifest(), true, '중단된 초기 방송 목록을 다시 불러온다');
  await playing;
  assert.equal($('audio-toggle').checked, true);
  assert.equal($('audio-status').textContent, '오디오 재생 중');
  const sourceLoads = players[0].sourceLoads;
  toggle(false);
  const resumed = toggle(true);
  assert.equal(players[0].sourceLoads, sourceLoads, '이미 읽은 방송 목록은 일시정지 후 다시 불러오지 않는다');
  await resumed;
  assert.equal($('audio-status').textContent, '오디오 재생 중');
});
}
