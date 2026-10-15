import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('ON AIR 채널을 선택하고 저장 기록 이후 누락분·수정·일시정지·따라가기를 처리한다', async t => {
  const frames = [], nodes = {}, requests = [], streams = [], documentHandlers = new Map(), timers = new Map();
  let nextTimer = 1;
  const scroller = { scrollTop: 0 }, toolbar = { top: 480, height: 320 }, header = { height: 150 };
  function element(tag = 'div') {
    return { tag, value: '', checked: false, textContent: '', style: {}, children: [], attributes: {},
      append(...children) { for (const child of children) this.children.push(...(child.tag === 'fragment' ? child.children : [child])); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      querySelector() { return this.children.filter(child => child.tag === 'article').at(-1) || null; },
      getBoundingClientRect() { return { bottom: 1700 - scroller.scrollTop }; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener() {}, click() {},
    };
  }
  Object.assign(scroller, {
    getBoundingClientRect() { return { top: header.height, bottom: toolbar.top, height: toolbar.top - header.height }; },
    scrollTo({ top }) { this.scrollTop = top; },
  });
  nodes['caption-scroller'] = scroller;
  const bodyClasses = new Set();
  const document = { visibilityState: 'visible', documentElement: { style: { setProperty() {} } }, scrollingElement: scroller,
    body: { classList: { add(name) { bodyClasses.add(name); }, remove(name) { bodyClasses.delete(name); }, contains(name) { return bodyClasses.has(name); } } },
    getElementById(id) { return nodes[id] ??= element(); }, createElement: element,
    createDocumentFragment() { return element('fragment'); }, addEventListener(name, fn) { documentHandlers.set(name, fn); },
    querySelector(selector) { return { getBoundingClientRect() { return selector === '.top-panel' ? header : toolbar; } }; }, head: element('head'),
  };
  const audio = Object.assign(element('audio'), { canPlayType() { return 'maybe'; }, pause() {}, load() {}, removeAttribute() {} });
  nodes['broadcast-audio'] = audio;
  document.getElementById('follow').checked = true;
  document.getElementById('mode').value = 'clean';
  const saved = new Map([['assembly-caption-channel', '25']]);
  const compactScreen = { matches: true, addEventListener() {} };
  const window = { innerHeight: 800, isSecureContext: false, addEventListener() {}, scrollTo({ top }) { scroller.scrollTop = top; },
    matchMedia() { return compactScreen; },
    setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    localStorage: { getItem(key) { return saved.get(key) ?? null; }, setItem(key, value) { saved.set(key, value); } } };
  const source = 'wss://example.test', audioUrl = 'https://broadcast.test/live.m3u8';
  let noOnAir = false;
  const caption = (id, text, revision) => ({ id, key: `segment-${id}`, day: '2026-10-14', text, revision, final: false,
    at: `2026-10-14T08:00:0${id}Z` });
  const originals = new Map();
  const globals = { document, window, navigator: { userAgent: 'Version/18 Safari' },
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    EventSource: class {
      constructor(url) { this.url = url; this.listeners = {}; streams.push(this); }
      addEventListener(name, fn) { this.listeners[name] = fn; }
      close() { this.closed = true; }
      emit(name, item) { this.listeners[name]?.({ data: JSON.stringify(item) }); }
    },
    async fetch(url) {
      requests.push(url);
      if (url === '/api/config') return { ok: true, json: async () => ({ today: '2026-10-14', channelRefreshMs: 30000 }) };
      if (url.startsWith('/api/channels')) return { ok: true, json: async () => ({ today: '2026-10-14', refreshedAt: '2026-10-14T08:00:00Z',
        channels: noOnAir ? [
          { id: '25', name: '법사위', subject: '국정감사 종료', statusText: '산회', onAir: false, pageUrl: 'https://assembly.test/live?25' },
          { id: '33', name: '복지위', subject: '오전 회의', statusText: '생중계 없음', onAir: false, pageUrl: 'https://assembly.test/live?33' },
        ] : [{ id: '45', name: '행안위', subject: '국정감사', statusText: '감사계속', onAir: true,
          source: 'wss://other.test', audioUrl: 'https://other.test/live.m3u8', collector: { state: 'connected' } },
        { id: '25', name: '법사위', subject: '국정감사', statusText: '감사계속', onAir: true,
          source, audioUrl, collector: { state: 'connected' } },
        { id: '33', name: '복지위', subject: '', statusText: '생중계 없음', onAir: false }] }) };
      const after = new URL(url, 'http://test').searchParams.get('after');
      return { ok: true, json: async () => after === '0' ?
        { day: '2026-10-14', rows: [caption(1, '저장된 첫 문장', 1)], cursor: 1, hasMore: true, next: 1 } :
        { day: '2026-10-14', rows: [caption(2, '불러오는 동안 생긴 문장', 3)], cursor: 3, hasMore: false, next: 2 } };
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const stream of streams) stream.close();
    for (const [name, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name];
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const flush = () => { let guard = 0; while (frames.length && guard++ < 100) frames.shift()(); };
  await import(`../client.mjs?test=${Date.now()}`); await settle(); await settle(); await settle(); flush();
  assert.ok(streams[0].url.endsWith('since=1'), 'Uses first snapshot watermark, not later page cursor');
  assert.ok(streams[0].url.includes('channel=25'));
  assert.ok(streams[0].url.includes('date=2026-10-14'));
  assert.equal(nodes.channel.value, '25');
  assert.equal(saved.get('assembly-caption-channel'), '25');
  assert.equal(nodes.rows.children.length, 2);
  assert.equal(nodes.connect.checked, true);
  assert.equal(timers.size, 1, '모바일 실시간 재생은 유휴 숨김 타이머를 예약한다');
  [...timers.values()].at(-1)(); timers.clear();
  assert.equal(document.body.classList.contains('chrome-hidden'), true, '유휴 상태에서 상단·하단 도구를 접는다');
  documentHandlers.get('pointerdown')();
  assert.equal(document.body.classList.contains('chrome-hidden'), false, '화면을 만지면 도구가 다시 나타난다');
  streams[0].emit('caption', { cursor: 2, caption: caption(1, '초안을 교체한 문장', 2) }); flush();
  assert.equal(nodes.rows.children.length, 2);
  assert.equal(nodes.rows.children[0].textContent, '초안을 교체한 문장');
  assert.deepEqual(nodes.rows.children[0].children, [], 'Caption has no timestamp or raw-message details');
  nodes.connect.checked = false; nodes.connect.onchange(); assert.equal(streams[0].closed, true); assert.equal(nodes.connect.checked, false);
  assert.equal(document.body.classList.contains('chrome-hidden'), false, '자막을 멈추면 도구를 계속 표시한다');
  assert.equal(timers.size, 0, '자막을 멈추면 유휴 숨김 타이머를 해제한다');
  nodes.connect.checked = true; nodes.connect.onchange(); await settle(); flush(); assert.equal(streams.length, 2);
  nodes.date.value = '2026-10-13'; nodes.date.onchange(); await settle(); await settle(); flush();
  assert.equal(streams[1].closed, true); assert.equal(nodes.connect.disabled, true);
  assert.ok(requests.some(url => url.includes('date=2026-10-13')));
  nodes.date.value = '2026-10-14'; nodes.date.onchange(); await settle(); await settle(); flush();
  assert.equal(nodes.connect.disabled, false); assert.equal(streams.length, 3);
  nodes.mode.value = 'final'; nodes.mode.onchange(); flush(); assert.equal(nodes.rows.children[0].tag, 'p');
  nodes.mode.value = 'clean'; nodes.mode.onchange(); flush();
  for (const height of [568, 844, 1024, 900]) {
    window.innerHeight = height; toolbar.top = height - 250; toolbar.height = 250; scroller.scrollTop = 0;
    nodes.follow.onchange(); flush(); assert.equal(1700 - scroller.scrollTop, toolbar.top - 12);
  }
  nodes.search.value = '초안을 교체'; nodes.search.oninput(); flush(); assert.equal(nodes.rows.children.length, 1);
  assert.ok(requests.every(url => !url.includes('/api/audio')), 'Client never requests an audio proxy');
  noOnAir = true;
  await nodes['refresh-channels'].onclick(); await settle(); await settle(); flush();
  assert.equal(nodes.channel.disabled, false, 'ON AIR가 없어도 파싱된 채널 목록은 사용할 수 있다');
  assert.equal(nodes.channel.value, '25');
  assert.match(nodes.channel.children.find(option => option.value === '25').textContent, /○ 산회 · 법사위 · 국정감사 종료/);
  assert.match(nodes['channel-refresh-status'].textContent, /현재 ON AIR 없음 · 오늘 편성 채널 1개/);
  assert.equal(nodes.channel.children.some(option => option.value === '33'), false, '오늘 편성이 없는 위원회는 숨긴다');
  assert.equal(nodes.connect.disabled, true, '종료 채널에서는 실시간 재생을 비활성화한다');
  assert.equal(streams.at(-1).closed, true, '방송 종료 상태로 바뀌면 기존 실시간 연결을 닫는다');
});

test('다크테마·고정 레이아웃과 iPhone 형태의 자막·오디오 스위치를 유지한다', async () => {
  const html = await readFile(new URL('../captions.html', import.meta.url), 'utf8');
  assert.ok(html.includes('color-scheme:dark'));
  assert.ok(html.includes('position:fixed') && html.includes('bottom:0'));
  assert.ok(html.includes('id="caption-scroller"') && html.includes('overflow-y:auto'));
  assert.ok(html.includes('class="top-panel"') && html.includes('top:0'));
  assert.ok(html.includes('min-height:44px') && html.includes('font-size:16px'));
  assert.ok(html.includes('@media(max-width:480px)') && html.includes('minmax(0,1fr)'));
  assert.ok(!html.includes('id="stop"') && !html.includes('id="connect-label"'));
  assert.ok(html.includes('id="channel"') && html.includes('id="refresh-channels"'));
  assert.match(html, /id="refresh-channels"[^>]+aria-label="채널 새로고침"[^>]*><span class="refresh-icon"[^>]*>↻<\/span>/);
  assert.ok(html.indexOf('id="channel"') < html.indexOf('class="controls"'));
  assert.ok(html.includes('id="date"') && html.includes('class="switch-track"'));
  assert.match(html, /<input id="connect" class="ios-toggle" type="checkbox" role="switch" checked/);
  assert.match(html, /<input id="audio-toggle" class="ios-toggle" type="checkbox" role="switch"/);
  assert.doesNotMatch(html, /<button id="(?:connect|audio-toggle)"/);
  assert.ok(html.includes('body.chrome-hidden .top-panel') && html.includes('body.chrome-hidden .controls'));
  assert.ok(html.includes('body.chrome-hidden #caption-scroller{top:0;bottom:0}'));
  assert.ok(!html.includes('id="json"') && !html.includes('id="load"'));
  assert.ok(!html.includes('<time') && !html.includes('수신 원본 보기'));
  assert.equal(/[\u3040-\u30ff]/.test(html), false);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
});
