import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { CaptionCollector } from '../lib/collector.mjs';
import { CaptionStore } from '../lib/store.mjs';

class FakeSocket extends EventTarget {
  static instances = [];
  constructor(source, protocol) { super(); this.source = source; this.protocol = protocol; FakeSocket.instances.push(this); }
  close() { this.dispatchEvent(Object.assign(new Event('close'), { code: 1000 })); }
  open() { this.dispatchEvent(new Event('open')); }
  message(data) { this.dispatchEvent(Object.assign(new Event('message'), { data })); }
}

test('echo-protocol을 사용해 저장하고 연결 종료 후 재연결한다', async () => {
  FakeSocket.instances = [];
  const store = new CaptionStore(':memory:');
  const events = [], statuses = [];
  const collector = new CaptionCollector({ source: 'wss://example.test', store,
    WebSocketClass: FakeSocket, reconnectBaseMs: 5, onEvent: event => events.push(event), onStatus: status => statuses.push(status) });
  try {
    collector.start();
    const first = FakeSocket.instances[0];
    assert.equal(first.protocol, 'echo-protocol'); first.open();
    first.message('{"segment":1,"transcript":"저장한 자막","final":true}');
    first.message('{"segment":1,"transcript":"저장한 자막 수정","final":true}');
    assert.deepEqual(statuses, [{ state: 'connecting' }, { state: 'connected' }], '메시지 수신마다 중복 상태를 알리지 않는다');
    assert.equal(store.cursor(), 2); assert.equal(events[0].caption.text, '저장한 자막');
    first.close(); assert.equal(collector.state.state, 'reconnecting');
    await delay(20); assert.equal(FakeSocket.instances.length, 2);
    first.message('{"segment":2,"transcript":"오래된 연결의 메시지"}');
    assert.equal(store.cursor(), 2);
    collector.stop(); await delay(20); assert.equal(FakeSocket.instances.length, 2);
  } finally { collector.stop(); store.close(); }
});

test('중단 중 연결이 끊기면 재연결하고 확정본만 저장한다', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  FakeSocket.instances = [];
  const store = new CaptionStore(':memory:');
  const logs = [];
  const collector = new CaptionCollector({ source: 'wss://example.test', channelId: '26', store,
    WebSocketClass: FakeSocket, reconnectBaseMs: 5, logger: entry => logs.push(entry) });
  try {
    collector.start(); FakeSocket.instances[0].open();
    FakeSocket.instances[0].message('{"segment":8462,"segment-offset":17614640.64,"transcript":"잠시 감사를 중지했다가","final":false}');
    collector.pause('감사중지');
    FakeSocket.instances[0].close();
    t.mock.timers.tick(5);
    assert.equal(FakeSocket.instances.length, 2);
    assert.equal(collector.paused, true);
    const resumed = FakeSocket.instances[1]; resumed.open();
    t.mock.timers.tick(30 * 60000);
    assert.equal(resumed.closed, undefined, '중단 중 재연결에도 무수신 감시는 중지된 상태다');
    resumed.message('{"segment":8462,"segment-offset":17614640.64,"transcript":"잠시 감사를 중지했다가 계속하겠습니다","final":true}');
    assert.equal(store.cursor(), 1);
    assert.equal(collector.pendingDrafts.size, 0);
    assert.ok(logs.some(x => x.event === 'collector-disconnect' && x.pendingDraftCount === 1));
    assert.ok(logs.some(x => x.event === 'final-during-pause' && x.channelId === '26'));
  } finally { collector.stop(); store.close(); }
});

test('진단용 초안은 개수·길이를 제한하고 확정본 뒤의 재전송 초안을 제외한다', () => {
  FakeSocket.instances = [];
  const store = new CaptionStore(':memory:');
  const logs = [];
  const collector = new CaptionCollector({ source: 'wss://example.test', store,
    WebSocketClass: FakeSocket, logger: entry => logs.push(entry) });
  try {
    collector.start(); const socket = FakeSocket.instances[0]; socket.open();
    for (let segment = 1; segment <= 25; segment++) socket.message(JSON.stringify({
      segment, 'segment-offset': segment * 100, transcript: '가'.repeat(3000), final: false,
    }));
    assert.equal(store.cursor(), 0);
    collector.pause('감사중지');
    const paused = logs.find(x => x.event === 'collector-paused');
    assert.equal(paused.pendingDraftCount, 20);
    assert.ok(paused.pendingDrafts.every(x => x.text.length <= 500 && x.rawPreview.length <= 2048 && x.truncated));
    socket.message('{"segment":25,"segment-offset":2500,"transcript":"확정 문장","final":true}');
    socket.message('{"segment":25,"segment-offset":2500,"transcript":"재전송 초안","final":false}');
    assert.equal(collector.pendingDrafts.size, 19);
    assert.equal(store.cursor(), 1);
  } finally { collector.stop(); store.close(); }
});
