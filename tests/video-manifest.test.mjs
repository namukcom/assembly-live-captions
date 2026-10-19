import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoManifest } from '../lib/video-manifest.mjs';
import { parseBroadcastPage } from '../lib/broadcast-config.mjs';
import { createApp } from '../server.mjs';

const base = 'https://w-assembly.hscdn.com/assembly/';
const sources = [240, 480, 720, 1080].map(height => ({ height, url: `${base}test_${height}p/playlist.m3u8` }));
function playlist(height, uri = 'chunklist.m3u8') {
  return `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=${height * 3000},CODECS="avc1.4d4028,mp4a.40.2",RESOLUTION=${height * 2}x${height}\n${uri}\n`;
}

test('국회 응답의 화질을 보존하고 유효하지 않은 추가 영상 주소는 제외한다', () => {
  const config = parseBroadcastPage({ xsami: 'wss://smiai.webcast.go.kr/aistt/test', xhls: [{
    '240p': sources[0].url, '480p': sources[1].url, '720p': 'https://evil.test/video.m3u8',
  }] }, 'https://assembly.webcast.go.kr/main/service/live_play.asp');
  assert.deepEqual(config.videoSources, sources.slice(0, 2));
});

test('여러 화질의 실제 메타데이터와 절대 CDN 주소를 묶고 실패한 화질만 제외한다', async () => {
  const manifest = await createVideoManifest(sources, async (url, options) => {
    assert.equal(options.redirect, 'error');
    const height = Number(url.match(/_(\d+)p/)[1]);
    if (height === 1080) throw Error('offline');
    return { ok: true, text: async () => playlist(height) };
  });
  assert.equal((manifest.match(/#EXT-X-STREAM-INF/g) || []).length, 3);
  assert.ok(manifest.indexOf('x240') < manifest.indexOf('x720'));
  assert.ok(manifest.includes(`${base}test_480p/chunklist.m3u8`));
  assert.ok(!manifest.includes('1080'));
});

test('외부·HTTP 주소와 악성 하위 목록은 거부하고 재생 가능한 화질이 없으면 502를 반환한다', async () => {
  let calls = 0;
  await assert.rejects(createVideoManifest([{ url: 'https://evil.test/playlist' }, { url: 'http://localhost/playlist' }], async () => { calls++; }), { status: 502 });
  assert.equal(calls, 0);
  await assert.rejects(createVideoManifest(sources, async () => ({ ok: true,
    text: async () => playlist(240, 'https://evil.test/segments.m3u8') })), { status: 502 });
});

test('영상 목록 경로는 짧게 캐시하며 종료 채널·알 수 없는 채널을 거부한다', async t => {
  let calls = 0;
  const app = createApp({ filename: ':memory:', collect: false,
    liveListUrl: 'https://assembly.webcast.go.kr/main/service/live_list.asp',
    fetchImpl: async url => { calls++; return { ok: true, text: async () => playlist(url.includes('480') ? 480 : 240) }; },
  });
  app.channelManager.items.set('19', { id: '19', onAir: true, audioUrl: sources[0].url, videoSources: sources.slice(0, 2) });
  app.channelManager.items.set('20', { id: '20', onAir: false, audioUrl: sources[0].url });
  const address = await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const url = `http://127.0.0.1:${address.port}`;
  const responses = await Promise.all([fetch(`${url}/api/video.m3u8?channel=19`), fetch(`${url}/api/video.m3u8?channel=19`)]);
  assert.equal(calls, 2, '각 화질의 작은 목록만 한 번씩 요청한다');
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/vnd.apple.mpegurl/);
    assert.match(await response.text(), /test_240p\/chunklist.m3u8/);
  }
  assert.equal((await fetch(`${url}/api/video.m3u8?channel=20`)).status, 409);
  assert.equal((await fetch(`${url}/api/video.m3u8?channel=999`)).status, 404);
  assert.equal((await fetch(`${url}/media.mjs`)).status, 200);
});
