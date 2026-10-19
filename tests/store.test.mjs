import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CaptionStore } from '../lib/store.mjs';
import { isDay, parseCaption, seoulDay, seoulSlot } from '../lib/caption-format.mjs';

const source = 'wss://example.test/captions';
const at = '2026-10-14T08:00:00.000Z';
const raw = (segment, text, final = false, offset = segment * 100) => JSON.stringify({
  segment, transcript: text, transcripts: [[-1, text]], final, 'segment-offset': offset,
});

test('문장 번호로 초안, 전면 수정, 뒤늦은 수정과 화자 분리를 반영한다', () => {
  const store = new CaptionStore(':memory:');
  try {
    const first = store.ingest(raw(1, '처음 자막'), source, at);
    store.ingest(raw(1, '완전히 다른 확정 내용', true), source, at);
    store.ingest(raw(2, '다음 문장'), source, at);
    const late = store.ingest(JSON.stringify({ segment: 1, 'segment-offset': 100, final: true,
      transcript: '수정', transcripts: [[0, '첫 화자'], [1, '둘째 화자']] }), source, at);
    assert.equal(late.caption.id, first.caption.id);
    assert.equal(late.caption.text, '첫 화자\n둘째 화자');
    assert.equal(store.rows({ day: '2026-10-14' }).length, 2);
    assert.equal(store.rows({ day: '2026-10-14', mode: 'final' }).length, 1);
    assert.equal([...store.records('2026-10-14')].length, 4);
    assert.deepEqual(store.eventsAfter(1, '2026-10-14').map(item => item.cursor), [2, 3, 4]);
  } finally { store.close(); }
});

test('서버 재시작 후 기록이 유지되고 다른 날짜와 방송 구간을 구분한다', () => {
  const filename = join(tmpdir(), `caption-${randomUUID()}.sqlite`);
  let store = new CaptionStore(filename);
  try {
    store.ingest(raw(1, '첫 방송', true, 100), source, at);
    store.ingest(raw(1, '새 방송', true, 200), source, at);
    store.ingest(raw(1, '다음 날', true, 100), source, '2026-10-14T15:00:01Z');
    store.close(); store = new CaptionStore(filename);
    assert.equal(store.rows({ day: '2026-10-14' }).length, 2);
    assert.equal(store.rows({ day: '2026-10-15' })[0].text, '다음 날');
    assert.equal(store.cursor(), 3);
    assert.deepEqual(store.dates().map(row => row.day), ['2026-10-15', '2026-10-14']);
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(filename + suffix, { force: true });
  }
});

test('빈 자막과 제어 메시지는 화면 기록에 추가하지 않고 원본은 보존한다', () => {
  const store = new CaptionStore(':memory:');
  try {
    store.ingest(raw(1, ''), source, at);
    store.ingest('{"heartbeat":true}', source, at);
    assert.equal(store.rows({ day: '2026-10-14' }).length, 0);
    assert.equal(store.cursor(), 2);
    assert.equal(parseCaption('{"heartbeat":true}'), null);
  } finally { store.close(); }
});

test('한국 날짜 경계와 5분 시간 구간, 날짜 유효성을 확인한다', () => {
  assert.equal(seoulDay('2026-10-14T14:59:59Z'), '2026-10-14');
  assert.equal(seoulDay('2026-10-14T15:00:00Z'), '2026-10-15');
  assert.equal(isDay('2026-02-30'), false);
  assert.equal(isDay('2026-10-14'), true);
  for (const [time, slot] of [
    ['08:04:59.999', '17:00'], ['08:05:00.000', '17:05'],
    ['08:09:59.999', '17:05'], ['08:10:00.000', '17:10'],
    ['08:59:59.999', '17:55'], ['09:00:00.000', '18:00'],
    ['14:59:59.999', '23:55'], ['15:00:00.000', '00:00'],
  ]) assert.equal(seoulSlot(`2026-10-14T${time}Z`), slot);
  assert.equal(seoulSlot('invalid'), null);
});

test('위원회 채널별로 자막, 원본 이벤트와 TXT 내용을 분리하고 5분 단위 타임스탬프를 표시한다', () => {
  const store = new CaptionStore(':memory:');
  try {
    const other = 'wss://example.test/other';
    store.ingest(raw(1, '첫 채널'), source, at);
    store.ingest(raw(1, '다른 채널'), other, at);
    store.ingest(raw(2, '5분 뒤 문장'), other, '2026-10-14T08:05:00.000Z');
    store.ingest(raw(3, '같은 5분 구간 문장'), other, '2026-10-14T08:09:59.999Z');
    store.ingest(raw(4, '다음 5분 구간 문장'), other, '2026-10-14T08:10:00.000Z');
    assert.deepEqual(store.rows({ day: '2026-10-14', source }).map(row => row.text), ['첫 채널']);
    assert.deepEqual(store.rows({ day: '2026-10-14', source: other }).map(row => row.text), ['다른 채널', '5분 뒤 문장', '같은 5분 구간 문장', '다음 5분 구간 문장']);
    assert.equal(store.eventsAfter(0, '2026-10-14', source).length, 1);
    assert.deepEqual([...store.textRows('2026-10-14', 'clean', other)], ['다른 채널', '─── 17:05 ───', '5분 뒤 문장', '같은 5분 구간 문장', '─── 17:10 ───', '다음 5분 구간 문장']);
  } finally { store.close(); }
});

test('채널 원본 주소를 기억하고 같은 원본을 쓰는 채널도 ID로 분리한다', () => {
  const store = new CaptionStore(':memory:');
  try {
    store.rememberChannelSource('25', source, at);
    store.ingest(raw(1, '법사위 자막'), source, at, '25');
    store.ingest(raw(1, '특별위 자막'), source, at, '91');
    assert.deepEqual(store.sourcesForChannel('25'), [source]);
    assert.deepEqual(store.rows({ day: '2026-10-14', channelId: '25', source }).map(row => row.text), ['법사위 자막']);
    assert.deepEqual([...store.textRows('2026-10-14', 'clean', source, '91')], ['특별위 자막']);
  } finally { store.close(); }
});

test('기존 DB의 자막에 source 열을 추가하고 채널 값을 복구한다', () => {
  const filename = join(tmpdir(), `caption-legacy-${randomUUID()}.sqlite`);
  const legacy = new DatabaseSync(filename);
  legacy.exec(`CREATE TABLE captions (id INTEGER PRIMARY KEY AUTOINCREMENT, segment_key TEXT NOT NULL UNIQUE,
    day TEXT NOT NULL, text TEXT NOT NULL, final INTEGER, first_at TEXT NOT NULL,
    last_at TEXT NOT NULL, last_message_id INTEGER NOT NULL)`);
  legacy.prepare('INSERT INTO captions(segment_key,day,text,final,first_at,last_at,last_message_id) VALUES(?,?,?,?,?,?,?)')
    .run(JSON.stringify([source, '2026-10-14', '100', '1']), '2026-10-14', '기존 자막', 1, at, at, 1);
  legacy.close();
  const store = new CaptionStore(filename);
  try { assert.equal(store.rows({ day: '2026-10-14', source })[0].text, '기존 자막'); }
  finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(filename + suffix, { force: true });
  }
});
