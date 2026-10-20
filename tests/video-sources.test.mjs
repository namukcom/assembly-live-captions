import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBroadcastPage } from '../lib/broadcast-config.mjs';
import { createApp } from '../server.mjs';

const base = 'https://w-assembly.hscdn.com/assembly/';
const sources = [240, 480, 720, 1080].map(height => ({ height, url: `${base}test_${height}p/playlist.m3u8` }));

test('국회 응답의 화질을 보존하고 유효하지 않은 추가 영상 주소는 제외한다', () => {
  const config = parseBroadcastPage({ xsami: 'wss://smiai.webcast.go.kr/aistt/test', xhls: [{
    '240p': sources[0].url, '480p': sources[1].url, '720p': 'https://evil.test/video.m3u8',
  }] }, 'https://assembly.webcast.go.kr/main/service/live_play.asp');
  assert.deepEqual(config.videoSources, sources.slice(0, 2));
});

test('서버는 국회 원본 주소만 전달하고 영상 목록을 생성하거나 요청하지 않는다', async t => {
  let calls = 0;
  const app = createApp({ filename: ':memory:', collect: false,
    liveListUrl: 'https://assembly.webcast.go.kr/main/service/live_list.asp',
    fetchImpl: async () => { calls++; throw Error('서버에서 재생 목록을 요청하면 안 된다'); },
  });
  app.channelManager.items.set('19', { id: '19', onAir: true, audioUrl: sources[0].url,
    videoDefaultUrl: sources[1].url, videoSources: sources.slice(0, 2) });
  const address = await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const url = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${url}/api/channels`);
  assert.equal(response.status, 200);
  const { channels } = await response.json();
  assert.equal(channels[0].videoDefaultUrl, sources[1].url);
  assert.deepEqual(channels[0].videoSources, sources.slice(0, 2));
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await fetch(`${url}/api/video.m3u8?channel=19`, { method })).status, 404);
  }
  assert.equal(calls, 0);
  assert.equal((await fetch(`${url}/media.mjs`)).status, 200);
  assert.equal((await fetch(`${url}/adaptive-video.mjs`)).status, 200);
  assert.equal((await fetch(`${url}/hls-variants.mjs`)).status, 200);
});
