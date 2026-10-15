import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBroadcastList, loadBroadcastPage, parseBroadcastList, parseBroadcastPage } from '../lib/broadcast-config.mjs';

const pageUrl = 'https://assembly.webcast.go.kr/main/service/live_play.asp?xcode=25&xcgcd=DCM00002522439A401';
const response = {
  xfull: '법제사법위원회', xsubj: '법제사법위원회 국정감사(군사법원)', xstat: '1',
  qtime: '2026-10-15 20:58:50', xsami: 'wss://smiai.webcast.go.kr:8091/aistt/beopsa',
  xhls: [{ default: 'https://w-assembly.hscdn.com/assembly/beopsa_480p/playlist.m3u8',
    '240p': 'https://w-assembly.hscdn.com/assembly/beopsa_240p/playlist.m3u8' }],
};

test('국회 생중계 응답에서 자막과 240p 오디오 주소를 만든다', () => {
  const config = parseBroadcastPage(response, pageUrl);
  assert.equal(config.source, 'wss://smiai.webcast.go.kr:8091/aistt/beopsa/hls');
  assert.equal(config.audioUrl, 'https://w-assembly.hscdn.com/assembly/beopsa_240p/playlist.m3u8');
  assert.equal(config.broadcast.committee, '법제사법위원회');
});

test('허용된 국회 페이지를 JSON으로 불러오고 잘못된 원본 주소는 거부한다', async () => {
  const config = await loadBroadcastPage(pageUrl, async (url, options) => {
    assert.equal(url.hostname, 'assembly.webcast.go.kr');
    assert.equal(options.headers.Accept, 'application/json');
    return { ok: true, json: async () => response };
  });
  assert.equal(config.broadcast.subject, response.xsubj);
  await assert.rejects(() => loadBroadcastPage('https://example.com/live.json'), /assembly\.webcast\.go\.kr/);
  assert.throws(() => parseBroadcastPage({ ...response, xsami: 'http://invalid.test' }, pageUrl), /wss:/);
});

test('국회 생중계 목록에서 ON AIR 상태와 재생 페이지 주소를 만든다', async () => {
  const listUrl = 'https://assembly.webcast.go.kr/main/service/live_list.asp';
  const value = { xlist: [
    { xcode: '45', xcgcd: 'DCM45', xname: '행안위', xstat: '1', xsubj: '국정감사', xdesc: '감사계속' },
    { xcode: '12', xcgcd: 'DCM12', xname: '국방위', xstat: '0', xsubj: '오후 회의', xdesc: '중계 예정' },
    { xcode: '33', xcgcd: 'DCM33', xname: '복지위', xstat: '0', xsubj: '', xdesc: '생중계 없음' },
  ] };
  const channels = parseBroadcastList(value, listUrl);
  assert.equal(channels[0].onAir, true);
  assert.equal(channels[0].pageUrl, 'https://assembly.webcast.go.kr/main/service/live_play.asp?xcode=45&xcgcd=DCM45');
  assert.equal(channels[1].onAir, false);
  assert.equal(channels[1].pageUrl, 'https://assembly.webcast.go.kr/main/service/live_play.asp?xcode=12&xcgcd=DCM12');
  assert.equal(channels.some(channel => channel.id === '33'), false, '생중계 없음 상태의 위원회는 편성 코드가 있어도 제외한다');
  const loaded = await loadBroadcastList(listUrl, async () => ({ ok: true, json: async () => value }));
  assert.equal(loaded.channels.length, 2);
});
