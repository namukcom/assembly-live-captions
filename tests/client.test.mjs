import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('ON AIR 채널은 wss를 먼저 연결해 버퍼링하고 /api/captions와 합쳐 화면에 표시한다', async t => {
  const frames = [], nodes = {}, requests = [], streams = [], documentHandlers = new Map(), windowHandlers = new Map(), timers = new Map();
  const layoutWrites = [];
  let layoutReads = 0;
  let nextTimer = 1;
  const scroller = { scrollTop: 0 }, toolbar = { top: 480, height: 320 }, header = { height: 150 };
  function element(tag = 'div') {
    const classes = new Set(), handlers = new Map();
    let content = '';
    return { tag, value: '', checked: false, textWrites: 0, style: {}, children: [], attributes: {},
      get textContent() { return content; }, set textContent(value) { content = value; this.textWrites++; },
      hidden: false, classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
        toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); } },
      contains() { return false; },
      appendedChildren: 0, replaceCalls: 0,
      append(...children) { for (const child of children) {
        const items = child.tag === 'fragment' ? child.children : [child];
        this.children.push(...items); this.appendedChildren += items.length;
      } },
      replaceChildren(...children) { this.replaceCalls++; this.children = []; this.append(...children); },
      querySelector() { return this.children.filter(child => child.tag === 'article').at(-1) || null; },
      getBoundingClientRect() { return { bottom: 1700 - scroller.scrollTop }; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, fn) { handlers.set(name, fn); }, emit(name) { handlers.get(name)?.(); },
      click() {}, focus() { this.focused = true; },
    };
  }
  Object.assign(scroller, {
    getBoundingClientRect() { return { top: header.height, bottom: toolbar.top, height: toolbar.top - header.height }; },
    scrollCalls: 0, scrollTo({ top }) { this.scrollCalls++; this.scrollTop = top; },
  });
  nodes['caption-scroller'] = scroller;
  const bodyClasses = new Set();
  const document = { visibilityState: 'visible', documentElement: { style: { setProperty(...args) { layoutWrites.push(args); } } }, scrollingElement: scroller,
    body: { classList: { add(name) { bodyClasses.add(name); }, remove(name) { bodyClasses.delete(name); }, contains(name) { return bodyClasses.has(name); },
      toggle(name, force) { if (force ?? !bodyClasses.has(name)) bodyClasses.add(name); else bodyClasses.delete(name); } } },
    getElementById(id) { return nodes[id] ??= element(); }, createElement: element,
    createDocumentFragment() { return element('fragment'); }, addEventListener(name, fn) {
      const previous = documentHandlers.get(name);
      documentHandlers.set(name, (event = {}) => { previous?.(event); fn(event); });
    },
    querySelector(selector) { return { getBoundingClientRect() { layoutReads++; return selector === '.top-panel' ? header : toolbar; } }; }, head: element('head'),
  };
  const audio = Object.assign(element('audio'), { canPlayType() { return 'maybe'; }, pause() {}, load() {}, removeAttribute() {} });
  nodes['broadcast-audio'] = audio;
  nodes['broadcast-video'] = Object.assign(element('video'), { canPlayType() { return 'maybe'; }, pause() {}, load() {}, removeAttribute() {} });
  document.getElementById('media-panel').hidden = true;
  document.getElementById('search-panel').hidden = true;
  document.getElementById('follow').checked = true;
  document.getElementById('mode').value = 'clean';
  const saved = new Map([['assembly-caption-channel', '25']]);
  const compactScreen = { matches: false, addEventListener() {} };
  const window = { innerHeight: 800, isSecureContext: false, addEventListener(name, fn) { windowHandlers.set(name, fn); }, scrollTo({ top }) { scroller.scrollTop = top; },
    matchMedia() { return compactScreen; },
    setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    localStorage: { getItem(key) { return saved.get(key) ?? null; }, setItem(key, value) { saved.set(key, value); } } };
  const source = 'wss://example.test', audioUrl = 'https://broadcast.test/live.m3u8';
  let noOnAir = false, missingCaptionSource = false, wsOpenedBeforeCaptions = false, bufferedSent = false;
  const caption = (id, text) => ({ id, k: `${id * 100}:${id}`, text, final: false,
    at: `2026-10-14T08:00:0${id}Z` });
  const wsFrame = (segment, text, final = false, extra = {}) => ({
    segment, 'segment-offset': segment * 100, transcript: text, final, ...extra,
  });
  const originals = new Map();
  const globals = { document, window, navigator: { userAgent: 'Version/18 Safari' },
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    WebSocket: class {
      constructor(url, protocol) {
        this.url = url;
        this.protocol = protocol;
        streams.push(this);
      }
      close() { this.closed = true; }
      emit(name, item) {
        if (name === 'caption') {
          const payload = item?.caption ? wsFrame(item.caption.id, item.caption.text, item.caption.final, { at: item.caption.at }) :
            item?.record ? { record: item.record } : item;
          this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
        }
      }
    },
    async fetch(url) {
      requests.push(url);
      if (url === '/api/config') return { ok: true, json: async () => ({ today: '2026-10-14', channelRefreshMs: 30000 }) };
      if (url.startsWith('/api/channels')) return { ok: true, json: async () => ({ today: '2026-10-14', refreshedAt: '2026-10-14T08:00:00Z',
        channels: noOnAir ? [
          { id: '25', name: '법사위', subject: '국정감사 종료', statusText: '산회', onAir: false, audioUrl, pageUrl: 'https://assembly.test/live?25' },
          { id: '33', name: '복지위', subject: '오전 회의', statusText: '생중계 없음', onAir: false, pageUrl: 'https://assembly.test/live?33' },
        ] : [{ id: '45', name: '행안위', subject: '국정감사', statusText: '감사계속', onAir: true,
          source: 'wss://other.test', audioUrl: 'https://other.test/live.m3u8', collector: { state: 'connected' } },
        { id: '25', name: '법사위', subject: '국정감사', statusText: '감사계속', onAir: true,
          source: missingCaptionSource ? null : source, audioUrl, collector: { state: 'connected' } },
        { id: '33', name: '복지위', subject: '', statusText: '생중계 없음', onAir: false }] }) };
      const after = new URL(url, 'http://test').searchParams.get('after');
      if (after === '0' && streams.length === 1) {
        wsOpenedBeforeCaptions = true;
        if (!bufferedSent) {
          bufferedSent = true;
          streams[0].emit('caption', wsFrame(2, '불러오는 동안 생긴 문장', false, { at: '2026-10-14T08:00:02Z' }));
        }
      }
      return { ok: true, json: async () => after === '0' ?
        { day: '2026-10-14', rows: [caption(1, '저장된 첫 문장')], cursor: 1, hasMore: true, next: 1 } :
        after === '1' ?
        { day: '2026-10-14', rows: [caption(2, '서버 스냅샷의 이전 초안')], cursor: 3, hasMore: false, next: 2 } :
        { day: '2026-10-14', rows: [], cursor: 3, hasMore: false, next: Number(after) } };
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
  assert.equal(wsOpenedBeforeCaptions, true, 'captions 요청 전에 wss 연결을 먼저 시작한다');
  assert.equal(streams[0].url, source);
  assert.equal(streams[0].protocol, 'echo-protocol');
  assert.ok(requests.every(url => !url.startsWith('/api/events')), '실시간 자막은 /api/events 대신 wss에서 직접 읽는다');
  assert.equal(nodes.channel.value, '25');
  assert.equal(saved.get('assembly-caption-channel'), '25');
  assert.equal(nodes.rows.children.length, 2);
  assert.equal(nodes.rows.children[1].textContent, '불러오는 동안 생긴 문장', 'captions 수신 중 버퍼링된 wss 메시지를 세그먼트 키로 병합한다');
  assert.equal(nodes.connect.checked, true);
  const readsBeforeResize = layoutReads, writesBeforeResize = layoutWrites.length, scrollsBeforeResize = scroller.scrollCalls;
  for (let i = 0; i < 10; i++) windowHandlers.get('resize')();
  flush();
  assert.equal(layoutReads - readsBeforeResize, 2, '연속 크기 변경 알림은 프레임당 한 번만 측정한다');
  assert.equal(layoutWrites.length, writesBeforeResize, '높이가 같으면 CSS 값을 다시 쓰지 않는다');
  assert.equal(scroller.scrollCalls, scrollsBeforeResize, '이미 최신 문장 위치이면 다시 스크롤하지 않는다');
  header.height++;
  windowHandlers.get('resize')(); flush();
  assert.deepEqual(layoutWrites.at(-1), ['--header-height', '151px']);
  assert.equal(layoutWrites.length, writesBeforeResize + 1, '변경된 높이만 반영한다');
  header.height--; windowHandlers.get('resize')(); flush();
  const optionReplacements = nodes.channel.replaceCalls, firstOption = nodes.channel.children[0];
  await nodes['refresh-channels'].onclick(); await settle(); flush();
  assert.equal(nodes.channel.replaceCalls, optionReplacements, '동일한 채널 목록 갱신은 선택창을 교체하지 않는다');
  assert.equal(nodes.channel.children[0], firstOption);
  assert.equal(timers.size, 1, '넓은 PC 화면에서도 실시간 재생 중 유휴 숨김 타이머를 예약한다');
  [...timers.values()].at(-1)(); timers.clear();
  assert.equal(document.body.classList.contains('chrome-hidden'), true, '유휴 상태에서 상단·하단 도구를 접는다');
  documentHandlers.get('pointerdown')();
  assert.equal(document.body.classList.contains('chrome-hidden'), false, '화면을 만지면 도구가 다시 나타난다');
  nodes['search-toggle'].onclick();
  assert.equal(nodes['search-panel'].hidden, false);
  assert.equal(nodes.search.focused, true);
  assert.equal(timers.size, 0, '검색하는 동안에는 도구를 자동으로 숨기지 않는다');
  nodes['search-close'].onclick();
  assert.equal(nodes['search-panel'].hidden, true);
  assert.equal(nodes['search-toggle'].focused, true);
  streams[0].emit('caption', { cursor: 2, caption: caption(1, '초안을 교체한 문장', 2) }); flush();
  assert.equal(nodes.rows.children.length, 2);
  assert.equal(nodes.rows.children[0].textContent, '초안을 교체한 문장');
  assert.deepEqual(nodes.rows.children[0].children, [], 'Caption has no timestamp or raw-message details');
  streams[0].emit('caption', { cursor: 4, caption: { ...caption(3, '5분 뒤 새 문장', 4), at: '2026-10-14T08:05:02Z' } }); flush();
  assert.deepEqual(nodes.rows.children.map(child => child.textContent), ['초안을 교체한 문장', '불러오는 동안 생긴 문장', '─── 17:05 ───', '5분 뒤 새 문장']);
  nodes.follow.checked = false; scroller.scrollTop = 320;
  const replaceBeforePause = nodes.rows.replaceCalls, firstChildBeforePause = nodes.rows.children[0];
  nodes.connect.checked = false; nodes.connect.onchange(); assert.equal(streams[0].closed, true); assert.equal(nodes.connect.checked, false);
  assert.equal(document.body.classList.contains('chrome-hidden'), false, '자막을 멈추면 도구를 계속 표시한다');
  assert.equal(timers.size, 0, '자막을 멈추면 유휴 숨김 타이머를 해제한다');
  nodes.connect.checked = true; nodes.connect.onchange(); await settle(); flush(); assert.equal(streams.length, 2);
  assert.equal(nodes.rows.replaceCalls, replaceBeforePause, '일시정지 후 재개해도 전체 자막 목록을 새로고침하지 않는다');
  assert.equal(nodes.rows.children[0], firstChildBeforePause, '기존 자막 DOM 노드를 그대로 유지한다');
  assert.equal(scroller.scrollTop, 320, '새 자막 따라가기가 꺼져 있으면 재개 시 스크롤 위치를 유지한다');
  assert.ok(requests.at(-1).includes('after=2'), '재개 시 마지막으로 받은 서버 ID 이후만 증분 조회한다');
  nodes.follow.checked = true;
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
  nodes['search-toggle'].onclick();
  nodes.search.value = '저장된 첫'; nodes.search.oninput(); flush();
  assert.equal(nodes.rows.children.length, 1);
  assert.equal(nodes.rows.children[0].textContent, '저장된 첫 문장');
  nodes.search.onkeydown({ key: 'Escape', preventDefault() {} }); flush();
  assert.equal(nodes['search-panel'].hidden, true);
  assert.equal(nodes.search.value, '', '검색을 닫으면 숨겨진 검색 조건도 해제한다');
  assert.equal(nodes.rows.children.length, 2);
  assert.ok(requests.every(url => !url.includes('/api/audio')), 'Client never requests an audio proxy');
  noOnAir = true;
  await nodes['refresh-channels'].onclick(); await settle(); await settle(); flush();
  assert.equal(nodes.channel.disabled, false, 'ON AIR가 없어도 파싱된 채널 목록은 사용할 수 있다');
  assert.equal(nodes.channel.value, '25');
  assert.match(nodes.channel.children.find(option => option.value === '25').textContent, /✓ 법사위 · 산회 · 국정감사 종료/);
  assert.match(nodes['channel-refresh-status'].textContent, /현재 ON AIR 없음 · 오늘 편성 채널 1개/);
  const noSchedule = nodes.channel.children.find(option => option.value === '33');
  assert.ok(noSchedule, '오늘 편성이 없는 위원회도 과거 기록을 위해 보여준다');
  assert.equal(nodes.channel.children.at(-1).value, '33', '오늘 편성이 없는 채널은 목록 아래로 정렬한다');
  assert.notEqual(noSchedule.disabled, true, '방송이 없어도 과거 자막을 선택할 수 있다');
  assert.equal(nodes.connect.disabled, true, '종료 채널에서는 실시간 재생을 비활성화한다');
  assert.equal(nodes['audio-toggle'].disabled, false, '종료 채널도 주소가 있으면 오디오를 사용할 수 있다');
  assert.equal(nodes['video-toggle'].disabled, false, '자막 수신과 별개로 영상 주소가 있으면 재생할 수 있다');
  assert.equal(streams.at(-1).closed, true, '방송 종료 상태로 바뀌면 기존 실시간 연결을 닫는다');
  nodes.connect.checked = false; nodes.connect.onchange();
  const streamsBeforeRestart = streams.length;
  noOnAir = false;
  await nodes['refresh-channels'].onclick(); await settle(); await settle(); flush();
  assert.equal(nodes.connect.checked, true, 'ON AIR로 바뀌면 수동 중지 상태에서도 자막 수신을 자동으로 켠다');
  assert.equal(streams.length, streamsBeforeRestart + 1);
  assert.equal(nodes['audio-toggle'].checked, false, '자막 자동 시작은 오디오를 켜지 않는다');
  nodes.connect.checked = false; nodes.connect.onchange();
  await nodes['refresh-channels'].onclick(); await settle(); flush();
  assert.equal(nodes.connect.checked, false, '같은 ON AIR 상태의 주기 갱신은 사용자의 일시정지를 유지한다');
  assert.equal(streams.length, streamsBeforeRestart + 1);
  noOnAir = true;
  await nodes['refresh-channels'].onclick(); await settle(); await settle(); flush();
  noOnAir = false; missingCaptionSource = true;
  await nodes['refresh-channels'].onclick(); await settle(); await settle(); flush();
  assert.equal(nodes.connect.disabled, true, 'ON AIR여도 자막 주소를 기다리는 동안에는 수신하지 않는다');
  assert.equal(streams.length, streamsBeforeRestart + 1);
  missingCaptionSource = false;
  await nodes['refresh-channels'].onclick(); await settle(); await settle(); flush();
  assert.equal(nodes.connect.checked, true, '늦게 자막 주소가 확인되면 ON AIR 전환 시 요청한 수신을 시작한다');
  assert.equal(streams.length, streamsBeforeRestart + 2);
  nodes.connect.checked = false; nodes.connect.onchange();
  nodes.date.value = '2026-10-13'; nodes.date.onchange(); await settle(); await settle(); flush();
  noOnAir = true;
  await nodes['refresh-channels'].onclick(); await settle(); await settle(); flush();
  noOnAir = false;
  await nodes['refresh-channels'].onclick(); await settle(); await settle(); flush();
  assert.equal(nodes.date.value, '2026-10-13', '방송이 재개되어도 읽고 있던 과거 날짜를 유지한다');
  assert.equal(nodes.connect.disabled, true);
  assert.equal(streams.length, streamsBeforeRestart + 2, '과거 기록을 보고 있을 때는 실시간 수신을 자동 시작하지 않는다');
  nodes.date.value = '2026-10-14'; nodes.date.onchange(); await settle(); await settle(); flush();
  nodes.connect.checked = true; nodes.connect.onchange(); await settle(); await settle(); flush();
  compactScreen.matches = true;
  documentHandlers.get('touchstart')();
  document.activeElement = nodes.channel; nodes.channel.emit('focus');
  nodes.channel.value = '45'; nodes.channel.onchange(); await settle(); await settle(); flush();
  assert.equal(nodes.channel.value, '45');
  assert.equal(timers.size, 1, '모바일 채널 전환 후 선택창에 포커스가 남아도 자동 숨김을 예약한다');
  [...timers.values()].at(-1)(); timers.clear();
  assert.equal(document.body.classList.contains('chrome-hidden'), true);
  assert.equal(document.activeElement, nodes.channel, '자막 스크롤 영역으로 포커스를 옮길 필요가 없다');
  documentHandlers.get('keydown')({ key: 'Tab' });
  assert.equal(document.body.classList.contains('chrome-hidden'), false);
  assert.equal(timers.size, 0, '키보드로 채널 선택창을 조작할 때는 도구를 유지한다');
  nodes.channel.value = '25'; nodes.channel.onchange(); await settle(); await settle(); flush();
  assert.equal(timers.size, 0, '키보드 채널 변경 후에도 선택창 포커스를 보호한다');
  document.activeElement = nodes['caption-scroller']; nodes.channel.emit('blur');
  assert.equal(timers.size, 1, '키보드 포커스가 선택창을 떠나면 자동 숨김을 다시 예약한다');
  for (const id of ['date', 'mode']) {
    documentHandlers.get('touchstart')();
    document.activeElement = nodes[id]; nodes[id].emit('focus');
    assert.equal(timers.size, 1, `${id}: 터치 후 남은 포커스가 숨김을 막지 않는다`);
    [...timers.values()].at(-1)(); timers.clear();
    assert.equal(document.body.classList.contains('chrome-hidden'), true);
  }
  const liveStream = streams.at(-1), initialNode = nodes.rows.children[0];
  const baseTime = Date.parse('2026-10-14T08:10:00Z');
  const largeCaption = (index, revision = 1, text = `누적 발언 ${index}`) => ({ ...caption(1000 + index, text, revision),
    at: new Date(baseTime + index * 1000).toISOString(), final: true });
  const replacements = nodes.rows.replaceCalls;
  for (let index = 0; index < 20000; index++) liveStream.emit('caption', { cursor: 10 + index, caption: largeCaption(index) });
  flush();
  assert.equal(nodes.rows.replaceCalls, replacements, '2만 문장이 쌓여도 기존 목록을 다시 붙이지 않는다');
  assert.equal(nodes.rows.children[0], initialNode);
  const appended = nodes.rows.appendedChildren;
  liveStream.emit('caption', { cursor: 30000, caption: largeCaption(20000) }); flush();
  assert.equal(nodes.rows.replaceCalls, replacements);
  assert.equal(nodes.rows.appendedChildren - appended, 1, '누적 기록 뒤에 새 문장 하나만 추가한다');
  const lastArticle = nodes.rows.children.at(-1), textWrites = lastArticle.textWrites;
  for (let revision = 2; revision <= 101; revision++) liveStream.emit('caption', {
    cursor: 30000 + revision, caption: largeCaption(20000, revision, `실시간 수정 ${revision}`),
  });
  flush();
  assert.equal(lastArticle.textContent, '실시간 수정 101');
  assert.equal(lastArticle.textWrites - textWrites, 1, '한 프레임에 모인 수정 100회는 텍스트 갱신 한 번으로 합친다');
  assert.equal(nodes.rows.replaceCalls, replacements);
  assert.equal(nodes['fullscreen-history'], undefined, '일반 보기에서는 숨겨진 전체화면 목록을 생성하지 않는다');
  liveStream.emit('caption', { cursor: 31000, caption: { ...caption(999, '늦게 도착한 자막', 1), at: '2026-10-14T08:00:00Z' } }); flush();
  assert.equal(nodes.rows.children[0].textContent, '늦게 도착한 자막', '시간 순서가 바뀌면 올바르게 다시 정렬한다');
  nodes.mode.value = 'final'; nodes.mode.onchange(); flush();
  const finalReplacements = nodes.rows.replaceCalls, finalAppended = nodes.rows.appendedChildren;
  liveStream.emit('caption', { cursor: 32000, caption: { ...largeCaption(20001), final: false } }); flush();
  assert.equal(nodes.rows.replaceCalls, finalReplacements);
  assert.equal(nodes.rows.appendedChildren, finalAppended, '완성 문장 모드에는 초안을 추가하지 않는다');
  liveStream.emit('caption', { cursor: 32001, caption: largeCaption(20001, 2, '완성된 마지막 문장') }); flush();
  assert.equal(nodes.rows.children.at(-1).textContent, '완성된 마지막 문장');
  assert.equal(nodes.rows.replaceCalls, finalReplacements, '마지막 초안이 완성되면 기존 목록 뒤에만 추가한다');
  liveStream.emit('caption', { cursor: 32002, caption: { ...largeCaption(20001, 3), final: false } }); flush();
  assert.ok(!nodes.rows.children.some(child => child.textContent === '완성된 마지막 문장'), '완료 취소도 화면에 반영한다');
  nodes.mode.value = 'clean'; nodes.mode.onchange(); flush();
  nodes.search.value = '찾을 문장'; nodes.search.oninput(); flush();
  liveStream.emit('caption', { cursor: 32003, caption: largeCaption(20000, 102, '찾을 문장 첫 번째') }); flush();
  assert.equal(nodes.rows.children[0].textContent, '찾을 문장 첫 번째', '기존 문장의 수정으로 검색 결과에 진입한다');
  const searchReplacements = nodes.rows.replaceCalls, searchNode = nodes.rows.children[0];
  liveStream.emit('caption', { cursor: 32004, caption: largeCaption(19999, 2, '검색과 무관한 수정') }); flush();
  assert.equal(nodes.rows.replaceCalls, searchReplacements, '검색 결과가 같으면 전체 목록을 교체하지 않는다');
  liveStream.emit('caption', { cursor: 32005, caption: largeCaption(20000, 103, '찾을 문장 수정') }); flush();
  assert.equal(nodes.rows.children[0], searchNode);
  assert.equal(searchNode.textContent, '찾을 문장 수정');
  assert.equal(nodes.rows.replaceCalls, searchReplacements, '검색 중 내용 수정도 해당 문장만 갱신한다');
  liveStream.emit('caption', { cursor: 32006, caption: largeCaption(20002, 1, '찾을 문장 새 항목') }); flush();
  assert.deepEqual(nodes.rows.children.map(row => row.textContent), ['찾을 문장 수정', '찾을 문장 새 항목']);
  assert.equal(nodes.rows.replaceCalls, searchReplacements, '검색에 해당하는 새 문장은 뒤에만 추가한다');
  liveStream.emit('caption', { cursor: 32007, caption: largeCaption(20000, 104, '검색에서 제외') }); flush();
  assert.deepEqual(nodes.rows.children.map(row => row.textContent), ['찾을 문장 새 항목'], '수정으로 검색에서 빠진 문장은 제거한다');
  liveStream.emit('caption', { cursor: 32008, caption: largeCaption(19999, 3, '찾을 문장 앞 항목') }); flush();
  assert.deepEqual(nodes.rows.children.map(row => row.textContent), ['찾을 문장 앞 항목', '찾을 문장 새 항목'], '앞부분 검색 결과가 추가되면 정렬을 유지한다');
  nodes['search-close'].onclick(); flush();
  nodes.mode.value = 'raw'; nodes.mode.onchange(); await settle(); await settle(); flush();
  const rawStream = streams.at(-1), rawFirst = nodes.rows.children[0], rawReplacements = nodes.rows.replaceCalls;
  for (let index = 0; index < 20000; index++) rawStream.emit('caption', { cursor: 40000 + index, record: largeCaption(index) });
  flush();
  assert.equal(nodes.rows.replaceCalls, rawReplacements, '원본 메시지 2만 개도 기존 목록을 교체하지 않는다');
  assert.equal(nodes.rows.children[0], rawFirst);
  const rawLast = nodes.rows.children.at(-1), rawWrites = rawLast.textWrites, rawAppended = nodes.rows.appendedChildren;
  for (let revision = 2; revision <= 101; revision++) rawStream.emit('caption', {
    cursor: 70000 + revision, record: largeCaption(19999, revision, `원본 수정 ${revision}`),
  });
  flush();
  assert.equal(rawLast.textContent, '원본 수정 101');
  assert.equal(rawLast.textWrites - rawWrites, 1);
  assert.equal(nodes.rows.replaceCalls, rawReplacements);
  rawStream.emit('caption', { cursor: 71002, record: largeCaption(20000) }); flush();
  assert.equal(nodes.rows.appendedChildren - rawAppended, 1, '원본 메시지 하나는 한 항목만 추가한다');
  rawStream.emit('caption', { cursor: 71003, record: { ...caption(999, '늦은 원본', 1), at: '2026-10-14T08:00:00Z' } }); flush();
  assert.equal(nodes.rows.children[0].textContent, '늦은 원본');
  rawStream.emit('caption', { cursor: 71004, record: { ...caption(999, '   ', 2), at: '2026-10-14T08:00:00Z' } }); flush();
  assert.equal(nodes.rows.children[0], rawFirst, '빈 원본 메시지는 목록에서 제외한다');
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
  assert.match(html, /<input id="video-toggle" class="ios-toggle" type="checkbox" role="switch"/);
  assert.match(html, /id="video-options"[^>]*hidden/);
  assert.ok(html.match(/<section class="channel-bar"[\s\S]*?<\/section>/)[0].includes('id="date"'));
  const settings = html.match(/<div id="toolbar-settings"[\s\S]*?<\/div>/)[0];
  assert.ok(settings.includes('id="mode"') && settings.includes('id="txt"'));
  assert.match(html, /id="search-panel"[^>]*hidden/);
  assert.ok(!html.includes('id="tools-toggle"') && !html.includes('id="txt-tools"'));
  assert.doesNotMatch(html, /<button id="(?:connect|audio-toggle)"/);
  assert.ok(html.includes('body.chrome-hidden .top-panel') && html.includes('body.chrome-hidden .controls'));
  assert.ok(html.includes('body.chrome-hidden #caption-scroller{top:var(--video-height,0px);bottom:0}'));
  assert.ok(!html.includes('id="json"') && !html.includes('id="load"'));
  assert.ok(!html.includes('<time') && !html.includes('수신 원본 보기'));
  assert.equal(/[\u3040-\u30ff]/.test(html), false);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
});
