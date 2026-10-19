import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelManager } from '../lib/channel-manager.mjs';
import { CaptionStore } from '../lib/store.mjs';

class FakeSocket extends EventTarget {
  static instances = [];
  constructor(source) { super(); this.source = source; FakeSocket.instances.push(this); }
  close() { this.closed = true; }
}

const list = active => ({ xlist: [
  { xcode: '45', xcgcd: 'DCM45', xname: '행안위', xstat: active ? '1' : '0', xsubj: '감사', xdesc: active ? '감사계속' : '감사종료' },
  { xcode: '33', xcgcd: '', xname: '복지위', xstat: '0', xsubj: '', xdesc: '생중계 없음' },
] });
const detail = { xsami: 'wss://smiai.webcast.go.kr:8091/aistt/haengan',
  xhls: [{ '240p': 'https://w-assembly.hscdn.com/assembly/haengan_240p/playlist.m3u8' }],
  xfull: '행정안전위원회', xsubj: '감사', xstat: '1' };

test('ON AIR 채널 수집기를 시작하고 상태 변경 시 중지한다', async () => {
  FakeSocket.instances = [];
  const store = new CaptionStore(':memory:'); let active = true, detailCalls = 0;
  const fetchImpl = async url => {
    if (!url.pathname.endsWith('live_list.asp')) detailCalls++;
    return { ok: true, json: async () => url.pathname.endsWith('live_list.asp') ? list(active) : detail };
  };
  const manager = new ChannelManager({ store, fetchImpl, WebSocketClass: FakeSocket, refreshMs: 60000 });
  try {
    await manager.start();
    assert.equal(manager.get('45').onAir, true);
    assert.equal(manager.get('45').source, 'wss://smiai.webcast.go.kr:8091/aistt/haengan/hls');
    assert.deepEqual(store.sourcesForChannel('45'), ['wss://smiai.webcast.go.kr:8091/aistt/haengan/hls']);
    assert.equal(manager.get('33').onAir, false, '오늘 방송이 없는 채널도 목록에 유지한다');
    assert.equal(FakeSocket.instances.length, 1);
    assert.equal(detailCalls, 1);
    FakeSocket.instances[0].dispatchEvent(new Event('open'));
    await manager.refresh();
    assert.equal(detailCalls, 1, '이미 연결된 동일 편성 채널은 상세 페이지를 중복 조회하지 않는다');
    active = false; await manager.refresh();
    assert.equal(manager.get('45').onAir, false);
    assert.equal(manager.get('45').source, 'wss://smiai.webcast.go.kr:8091/aistt/haengan/hls');
    assert.equal(manager.collectors.size, 0); assert.equal(FakeSocket.instances[0].closed, true);
    assert.equal(manager.get('45').audioUrl, detail.xhls[0]['240p'], '방송 종료 후에도 현재 편성의 미디어 주소는 제공한다');
  } finally { manager.stop(); store.close(); }
});

test('방송 시작 전 미디어 주소를 조회하고 편성이 바뀌면 이전 주소를 제거하되 자막 이력은 유지한다', async () => {
  FakeSocket.instances = [];
  const store = new CaptionStore(':memory:');
  const historicalSource = 'wss://smiai.webcast.go.kr:8091/aistt/haengan/hls';
  store.rememberChannelSource('45', historicalSource);
  let schedule = 'DCM45', failDetails = false, detailCalls = 0;
  const fetchImpl = async url => {
    if (url.pathname.endsWith('live_list.asp')) return { ok: true, json: async () => ({ xlist: [
      { ...list(false).xlist[0], xcgcd: schedule, xdesc: '20:30 계속예정' }, list(false).xlist[1],
    ] }) };
    detailCalls++;
    if (failDetails) throw Error('temporary detail failure');
    return { ok: true, json: async () => ({ ...detail, xsami: 'wss://smiai.webcast.go.kr/aistt/standby' }) };
  };
  const manager = new ChannelManager({ store, fetchImpl, WebSocketClass: FakeSocket, refreshMs: 60000 });
  try {
    await manager.start();
    assert.equal(manager.get('45').onAir, false);
    assert.equal(manager.get('45').audioUrl, detail.xhls[0]['240p']);
    assert.equal(manager.get('45').source, historicalSource);
    assert.deepEqual(store.sourcesForChannel('45'), [historicalSource], '방송 전 임시 주소를 자막 이력에 섞지 않는다');
    assert.equal(manager.collectors.size, 0); assert.equal(FakeSocket.instances.length, 0);
    failDetails = true; await manager.refresh();
    assert.equal(manager.get('45').audioUrl, detail.xhls[0]['240p'], '같은 편성의 일시 조회 실패에는 확인된 주소를 유지한다');
    schedule = 'DCM46'; await manager.refresh();
    assert.equal(manager.get('45').audioUrl, null, '다른 편성에 이전 재생 주소를 재사용하지 않는다');
    schedule = ''; await manager.refresh();
    assert.equal(detailCalls, 3, '상세 페이지가 없는 채널은 조회하지 않는다');
    assert.equal(manager.get('45').audioUrl, null);
  } finally { manager.stop(); store.close(); }
});
