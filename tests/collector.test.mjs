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
  const events = [];
  const collector = new CaptionCollector({ source: 'wss://example.test', store,
    WebSocketClass: FakeSocket, reconnectBaseMs: 5, onEvent: event => events.push(event) });
  try {
    collector.start();
    const first = FakeSocket.instances[0];
    assert.equal(first.protocol, 'echo-protocol'); first.open();
    first.message('{"segment":1,"transcript":"저장한 자막","final":true}');
    assert.equal(store.cursor(), 1); assert.equal(events[0].caption.text, '저장한 자막');
    first.close(); assert.equal(collector.state.state, 'reconnecting');
    await delay(20); assert.equal(FakeSocket.instances.length, 2);
    first.message('{"segment":2,"transcript":"오래된 연결의 메시지"}');
    assert.equal(store.cursor(), 1);
    collector.stop(); await delay(20); assert.equal(FakeSocket.instances.length, 2);
  } finally { collector.stop(); store.close(); }
});
