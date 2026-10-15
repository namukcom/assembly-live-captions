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
  assert.equal(saved.get('assembly-caption-audio-enabled'), 'true');
  assert.equal($('audio-status').textContent, '오디오 재생 중');
  handlers.pause(); assert.equal(players[0].stopped, true);
  assert.equal($('audio-toggle').checked, false);
  assert.equal(saved.get('assembly-caption-audio-enabled'), 'false');
  await handlers.play(); assert.equal(audio.playCalls, 2);
  controller.setSource('https://original-broadcast.test/second.m3u8');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal($('audio-toggle').checked, true, '채널 변경 뒤에도 켜진 상태를 유지한다');
  assert.equal(audio.playCalls, 3, '변경된 채널의 오디오 재생을 이어간다');
  assert.equal(players.at(-1).source, 'https://original-broadcast.test/second.m3u8');
});

test('저장된 오디오 켬 상태를 새 페이지에서 복원한다', async t => {
  const nodes = {}, original = new Map(), saved = new Map([['assembly-caption-audio-enabled', 'true']]);
  const audio = { src: '', seekable: { length: 0 }, playCalls: 0,
    canPlayType() { return 'maybe'; }, pause() {}, load() {}, removeAttribute() {}, addEventListener() {},
    play() { this.playCalls++; return Promise.resolve(); } };
  const $ = id => nodes[id] ??= { value: '', textContent: '', disabled: false, checked: false };
  nodes['broadcast-audio'] = audio;
  $('audio-url').value = 'https://original-broadcast.test/live.m3u8';
  const values = {
    window: { localStorage: { getItem(key) { return saved.get(key) ?? null; }, setItem(key, value) { saved.set(key, value); } } },
    navigator: { userAgent: 'Version/18.0 Safari/605.1.15' },
  };
  for (const [name, value] of Object.entries(values)) {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  t.after(() => { for (const [name, descriptor] of original) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]; });
  initAudio($); await new Promise(resolve => setImmediate(resolve));
  assert.equal($('audio-toggle').checked, true);
  assert.equal(audio.playCalls, 1, '저장된 켬 상태이면 준비 후 자동 재생을 시도한다');
  assert.equal($('audio-status').textContent, '오디오 재생 중');
});
