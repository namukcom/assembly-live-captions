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
  } finally { manager.stop(); store.close(); }
});
