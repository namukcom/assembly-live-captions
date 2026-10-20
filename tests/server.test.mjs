import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createApp } from '../server.mjs';

const day = '2026-10-14', at = `${day}T08:00:00Z`, source = 'wss://example.test';
const raw = (segment, text, final = true) => JSON.stringify({ segment, 'segment-offset': segment * 100,
  transcript: text, final });

async function start(t, options = {}) {
  const app = createApp({ filename: ':memory:', collect: false, source, ...options });
  const address = await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  return { app, base: `http://127.0.0.1:${address.port}` };
}

async function sse(base, since, lastId) {
  const abort = new AbortController();
  const response = await fetch(`${base}/api/events?date=${day}&since=${since}`, {
    signal: abort.signal, headers: lastId === undefined ? {} : { 'Last-Event-ID': String(lastId) },
  });
  const reader = response.body.getReader();
  let buffer = '';
  return {
    async next(name) {
      while (true) {
        const index = buffer.indexOf('\n\n');
        if (index !== -1) {
          const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          if (block.includes(`event: ${name}\n`)) return JSON.parse(block.split('\n').find(line => line.startsWith('data: ')).slice(6));
        } else {
          const chunk = await reader.read();
          if (chunk.done) throw Error('Stream ended');
          buffer += new TextDecoder().decode(chunk.value);
        }
      }
    },
    close() { abort.abort(); reader.cancel().catch(() => {}); },
  };
}

test('기록 스냅샷을 불러오는 동안의 수정도 SSE로 이어받고 재접속 공백을 복구한다', { timeout: 10000 }, async t => {
  const { app, base } = await start(t);
  app.store.ingest(raw(1, '초안'), source, at);
  const snapshot = await (await fetch(`${base}/api/captions?date=${day}`)).json();
  assert.equal(snapshot.cursor, 1);
  const update = app.store.ingest(raw(1, '완성된 문장', true), source, at);
  const stream = await sse(base, snapshot.cursor); t.after(() => stream.close());
  const replay = await stream.next('caption');
  assert.equal(replay.caption.id, snapshot.rows[0].id);
  assert.equal(replay.caption.text, '완성된 문장'); assert.equal(replay.cursor, update.cursor);
  const live = app.store.ingest(raw(2, '새 문장'), source, at); app.collector.onEvent(live);
  assert.equal((await stream.next('caption')).caption.text, '새 문장');
  stream.close();
  const missed = app.store.ingest(raw(3, '화면을 닫은 동안 저장'), source, at);
  const resumed = await sse(base, 0, live.cursor); t.after(() => resumed.close());
  assert.equal((await resumed.next('caption')).cursor, missed.cursor);
});

test('오늘 기록, TXT 저장, JSON 제거, 잘못된 요청과 오디오 비중계 경로를 확인한다', async t => {
  const { app, base } = await start(t);
  app.store.ingest(raw(1, '초안', false), source, at);
  app.store.ingest(raw(1, '확정 문장', true), source, at);
  app.store.ingest(raw(2, '아직 작성 중', false), source, at);
  const final = await (await fetch(`${base}/api/captions?date=${day}&mode=final&limit=1`)).json();
  assert.equal(final.rows.length, 1); assert.equal(final.rows[0].text, '확정 문장');
  const txt = await (await fetch(`${base}/api/export?date=${day}&mode=final`)).text();
  assert.equal(txt.trim(), '확정 문장'); assert.ok(!txt.includes(at));
  assert.equal((await fetch(`${base}/api/export?date=${day}&format=json`)).status, 400);
  assert.equal((await fetch(`${base}/api/captions?date=2026-02-30`)).status, 400);
  assert.equal((await fetch(`${base}/api/captions?limit=9999`)).status, 400);
  assert.equal((await fetch(`${base}/api/audio`)).status, 404);
  assert.equal((await fetch(`${base}/data/captions.sqlite`)).status, 404);
  const htmlRes = await fetch(base);
  const html = await htmlRes.text(); assert.ok(html.includes('color-scheme:dark'));
  assert.equal(htmlRes.headers.get('x-frame-options'), 'DENY');
  assert.ok(htmlRes.headers.get('etag'));
  const cachedRes = await fetch(base, { headers: { 'If-None-Match': htmlRes.headers.get('etag') } });
  assert.equal(cachedRes.status, 304);
  const script = await fetch(`${base}/client.mjs`); assert.equal(script.status, 200);
});

test('오늘 방송이 없고 원본 주소가 없는 채널도 채널 ID로 과거 자막을 연다', async t => {
  let listCalls = 0;
  const app = createApp({ filename: ':memory:', collect: false,
    liveListUrl: 'https://assembly.webcast.go.kr/main/service/live_list.asp',
    fetchImpl: async () => { listCalls++; return { ok: true, json: async () => ({ xlist: [] }) }; } });
  app.channelManager.items.set('33', { id: '33', name: '복지위', onAir: false,
    statusText: '생중계 없음', source: null, historySources: [] });
  app.store.ingest(raw(1, '저장된 복지위 자막'), source, at, '33');
  const address = await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/api/captions?channel=33&date=${day}`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).rows.map(row => row.text), ['저장된 복지위 자막']);
  await fetch(`${base}/api/channels?refresh=1`);
  await fetch(`${base}/api/channels?refresh=1`);
  assert.equal(listCalls, 1, '연속 수동 새로고침 요청은 쿨다운 동안 한 번만 외부 목록을 호출한다');
});

test('GA는 ID가 없으면 삽입하지 않고 설정한 운영 도메인에서만 실행한다', async t => {
  const disabled = await start(t);
  const enabled = await start(t, { gaMeasurementId: 'G-59FNBCPP6F', gaHostname: 'captions.example.test' });
  for (const path of ['/', '/captions.html']) {
    const disabledHtml = await (await fetch(disabled.base + path)).text();
    assert.ok(!disabledHtml.includes('googletagmanager.com'));
    const html = await (await fetch(enabled.base + path)).text();
    const tags = [...html.matchAll(/<!-- Google tag \(gtag\.js\) -->\s*<script>([\s\S]*?)<\/script>/g)];
    assert.equal(tags.length, 1);
    for (const hostname of ['captions.example.test', 'soju.day', 'localhost', '127.0.0.1', 'fork.example.test']) {
      const scripts = [];
      const context = { location: { hostname }, document: {
        createElement: () => ({}), head: { appendChild: script => scripts.push(script) },
      } };
      context.window = context;
      runInNewContext(tags[0][1], context);
      if (hostname === 'captions.example.test') {
        assert.equal(scripts.length, 1);
        assert.equal(scripts[0].async, true);
        assert.equal(scripts[0].src, 'https://www.googletagmanager.com/gtag/js?id=G-59FNBCPP6F');
        assert.equal(context.dataLayer[1][0], 'config');
        assert.equal(context.dataLayer[1][1], 'G-59FNBCPP6F');
      } else {
        assert.equal(scripts.length, 0);
        assert.equal(context.dataLayer, undefined);
      }
    }
  }
});

test('GA 설정의 잘못된 값은 HTML에 삽입하기 전에 거부한다', () => {
  assert.throws(() => createApp({ filename: ':memory:', collect: false,
    gaMeasurementId: "G-X</script><script>alert(1)</script>" }), /GA_MEASUREMENT_ID/);
  assert.throws(() => createApp({ filename: ':memory:', collect: false,
    gaMeasurementId: 'G-59FNBCPP6F', gaHostname: 'https://soju.day/' }), /GA_HOSTNAME/);
});
