import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelManager } from '../lib/channel-manager.mjs';
import { CaptionStore } from '../lib/store.mjs';

class FakeSocket extends EventTarget {
  static instances = [];
  constructor(source) { super(); this.source = source; FakeSocket.instances.push(this); }
  close() { this.closed = true; }
  open() { this.dispatchEvent(new Event('open')); }
  message(value) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(value) })); }
}

const list = active => ({ xlist: [
  { xcode: '45', xcgcd: 'DCM45', xname: '행안위', xstat: active ? '1' : '0', xsubj: '감사', xdesc: active ? '감사계속' : '감사종료' },
  { xcode: '33', xcgcd: 'DCM33', xname: '복지위', xstat: '0', xsubj: '', xdesc: '생중계 없음' },
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
    assert.equal(detailCalls, 1, '생중계 없음 채널은 상세 페이지를 조회하지 않는다');
    FakeSocket.instances[0].dispatchEvent(new Event('open'));
    await manager.refresh();
    assert.equal(detailCalls, 1, '이미 연결된 동일 편성 채널은 상세 페이지를 중복 조회하지 않는다');
    active = false; await manager.refresh();
    assert.equal(detailCalls, 1, '감사종료 채널은 상세 페이지를 다시 조회하지 않는다');
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

test('감사 중단 중 연결을 유지해 늦은 확정본·화자 수정본을 받고 초안은 저장하지 않는다', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  FakeSocket.instances = [];
  const store = new CaptionStore(':memory:');
  let active = true, ended = false;
  const events = [];
  const logs = [];
  const fetchImpl = async url => ({ ok: true, json: async () => url.pathname.endsWith('live_list.asp')
    ? { xlist: [{ ...list(active).xlist[0], xdesc: active ? '감사계속' : ended ? '감사종료' : '14:00 계속예정' }] }
    : detail });
  const manager = new ChannelManager({ store, fetchImpl, WebSocketClass: FakeSocket,
    refreshMs: 60000, onEvent: (_, event) => events.push(event), logger: entry => logs.push(entry) });
  try {
    await manager.start();
    const socket = FakeSocket.instances[0]; socket.open();
    socket.message({ segment: 1, 'segment-offset': 100, transcript: '중단 직전 초안', final: false });
    assert.equal(store.cursor(), 0);
    active = false; await manager.refresh();
    assert.equal(manager.get('45').onAir, false);
    assert.equal(socket.closed, undefined, '일시 중단은 자막 연결을 유지한다');
    assert.equal(manager.collectors.size, 1);
    const paused = logs.find(x => x.event === 'collector-paused');
    assert.equal(paused.channelId, '45');
    assert.equal(paused.pendingDraftCount, 1);
    assert.equal(JSON.parse(paused.pendingDrafts[0].rawPreview).final, false);
    t.mock.timers.tick(9000);
    socket.message({ segment: 1, 'segment-offset': 100, transcript: '중단 직전 확정 문장', final: true });
    socket.message({ segment: 1, 'segment-offset': 100, transcript: '중단 직전 확정 문장 수정', final: true, scd: true });
    const rows = store.rows({ day: events.at(-1).day, channelId: '45' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, '중단 직전 확정 문장 수정');
    assert.equal(store.cursor(), 2);
    assert.equal(logs.filter(x => x.event === 'final-during-pause').length, 2);
    socket.message({ segment: 2, 'segment-offset': 200, transcript: '확정되지 않은 마지막 문장', final: false });
    t.mock.timers.tick(30 * 60000);
    assert.equal(socket.closed, undefined, '긴 정회 중에도 무수신 타이머로 연결을 닫지 않는다');
    assert.equal(manager.collectors.size, 1);
    assert.equal(store.cursor(), 2, '정회 중 초안을 확정본으로 바꾸어 저장하지 않는다');
    ended = true; await manager.refresh();
    assert.equal(socket.closed, true);
    assert.equal(manager.collectors.size, 0);
    assert.equal(logs.find(x => x.event === 'collector-stopped').pendingDrafts[0].text, '확정되지 않은 마지막 문장');
    assert.equal(logs.find(x => x.event === 'collector-stopped').reason, '감사종료');
  } finally { manager.stop(); store.close(); }
});

test('긴 중단과 반복 조회에도 같은 연결을 유지하고 속개 후 무수신 감시를 재개한다', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  FakeSocket.instances = [];
  const store = new CaptionStore(':memory:'); let active = true;
  const fetchImpl = async url => ({ ok: true, json: async () => url.pathname.endsWith('live_list.asp')
    ? { xlist: [{ ...list(active).xlist[0], xdesc: active ? '감사계속' : '감사중지' }] } : detail });
  const manager = new ChannelManager({ store, fetchImpl, WebSocketClass: FakeSocket, refreshMs: 60000 });
  try {
    await manager.start(); const socket = FakeSocket.instances[0]; socket.open();
    active = false; await manager.refresh();
    t.mock.timers.tick(15 * 60000); await manager.refresh();
    t.mock.timers.tick(15 * 60000);
    assert.equal(socket.closed, undefined);
    active = true; await manager.refresh();
    assert.equal(FakeSocket.instances.length, 1, '속개는 기존 연결을 재사용한다');
    t.mock.timers.tick(299999);
    assert.equal(socket.closed, undefined);
    assert.equal(manager.collectors.size, 1);
    t.mock.timers.tick(1);
    assert.equal(socket.closed, true, '속개 후에는 기존 무수신 감시가 다시 동작한다');
  } finally { manager.stop(); store.close(); }
});

test('중단된 채널의 주소를 다른 생방송 채널이 쓰면 이전 채널에 연결을 남기지 않는다', async () => {
  FakeSocket.instances = [];
  const store = new CaptionStore(':memory:'); let switched = false;
  const fetchImpl = async url => ({ ok: true, json: async () => url.pathname.endsWith('live_list.asp')
    ? { xlist: switched ? [
      { ...list(false).xlist[0], xdesc: '감사중지' },
      { xcode: '33', xcgcd: 'DCM33', xname: '복지위', xstat: '1', xdesc: '감사계속' },
    ] : [list(true).xlist[0]] } : detail });
  const manager = new ChannelManager({ store, fetchImpl, WebSocketClass: FakeSocket, refreshMs: 60000 });
  try {
    await manager.start(); FakeSocket.instances[0].open();
    switched = true; await manager.refresh();
    assert.equal(FakeSocket.instances[0].closed, true);
    assert.equal(manager.collectors.has('45'), false);
    assert.equal(manager.collectors.has('33'), true);
  } finally { manager.stop(); store.close(); }
});
