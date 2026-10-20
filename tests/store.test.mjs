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
const raw = (segment, text, final = true, offset = segment * 100) => JSON.stringify({
  segment, transcript: text, transcripts: [[-1, text]], final, 'segment-offset': offset,
});

test('미완성 초안은 DB에 저장하지 않고 완성 문장과 화자 분리 수정만 반영한다', () => {
  const store = new CaptionStore(':memory:');
  try {
    const draft = store.ingest(raw(1, '처음 자막 초안', false), source, at);
    assert.equal(draft.caption, null);
    assert.equal(store.cursor(), 0);
    const first = store.ingest(raw(1, '완전히 다른 확정 내용', true), source, at);
    store.ingest(raw(2, '다음 문장 초안', false), source, at);
    store.ingest(raw(2, '다음 확정 문장', true), source, at);
    const late = store.ingest(JSON.stringify({ segment: 1, 'segment-offset': 100, final: true,
      transcript: '수정', transcripts: [[0, '첫 화자'], [1, '둘째 화자']] }), source, at);
    assert.equal(late.caption.id, first.caption.id);
    assert.equal(late.caption.text, '첫 화자\n둘째 화자');
    assert.deepEqual(store.rows({ day: '2026-10-14' }), [
      { id: 1, text: '첫 화자\n둘째 화자', at, k: '100:1' },
      { id: 2, text: '다음 확정 문장', at, k: '200:2' },
    ]);
    assert.equal(store.rows({ day: '2026-10-14', mode: 'final' }).length, 2);
    assert.equal([...store.records('2026-10-14')].length, 2);
    assert.deepEqual(store.eventsAfter(1, '2026-10-14').map(item => item.cursor), [2, 3]);
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

test('빈 자막, 제어 메시지, 미완성 초안은 DB에 저장하지 않는다', () => {
  const store = new CaptionStore(':memory:');
  try {
    store.ingest(raw(1, ''), source, at);
    store.ingest(raw(1, '작성 중', false), source, at);
    store.ingest('{"heartbeat":true}', source, at);
    assert.equal(store.rows({ day: '2026-10-14' }).length, 0);
    assert.equal(store.cursor(), 0);
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

test('채널 원본 주소는 매핑 테이블에만 저장하고 자막 행에는 URL을 중복 저장하지 않는다', () => {
  const store = new CaptionStore(':memory:');
  try {
    store.rememberChannelSource('25', source, at);
    store.ingest(raw(1, '법사위 자막'), source, at, '25');
    store.ingest(raw(1, '특별위 자막'), source, at, '91');
    assert.deepEqual(store.sourcesForChannel('25'), [source]);
    assert.deepEqual(store.rows({ day: '2026-10-14', channelId: '25', source }).map(row => row.text), ['법사위 자막']);
    assert.deepEqual([...store.textRows('2026-10-14', 'clean', source, '91')], ['특별위 자막']);
    const storedRow = store.db.prepare('SELECT segment_key, source_id, channel_id FROM captions WHERE channel_id=?').get('25');
    assert.equal(storedRow.segment_key.includes(source), false, 'segment_key에 wss URL을 저장하지 않는다');
    assert.ok(storedRow.source_id > 0);
  } finally { store.close(); }
});

test('기존 운영 DB를 최초 1회 정규화하여 messages 테이블·미완성 초안·중복 URL을 정리한다', () => {
  const filename = join(tmpdir(), `caption-legacy-${randomUUID()}.sqlite`);
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL,
      day TEXT NOT NULL, source TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '', raw TEXT NOT NULL, segment_id INTEGER
    );
    CREATE TABLE captions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, segment_key TEXT NOT NULL UNIQUE,
      day TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', channel_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, final INTEGER,
      first_at TEXT NOT NULL, last_at TEXT NOT NULL, last_message_id INTEGER NOT NULL
    );
    CREATE TABLE channel_sources (
      channel_id TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(channel_id, source)
    );
  `);
  legacy.prepare('INSERT INTO messages(received_at,day,source,channel_id,raw,segment_id) VALUES(?,?,?,?,?,?)')
    .run(at, '2026-10-14', source, '25', raw(1, '기존 확정 자막', true), 1);
  legacy.prepare('INSERT INTO captions(segment_key,day,source,channel_id,text,final,first_at,last_at,last_message_id) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(JSON.stringify(['25', source, '2026-10-14', '100', '1']), '2026-10-14', source, '25', '기존 확정 자막', 1, at, at, 1);
  legacy.prepare('INSERT INTO captions(segment_key,day,source,channel_id,text,final,first_at,last_at,last_message_id) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(JSON.stringify(['25', source, '2026-10-14', '200', '2']), '2026-10-14', source, '25', '미완성 임시 자막', 0, at, at, 2);
  legacy.prepare('INSERT INTO channel_sources(channel_id,source,updated_at) VALUES(?,?,?)')
    .run('25', source, at);
  legacy.close();
  let store = new CaptionStore(filename);
  try {
    assert.deepEqual(store.rows({ day: '2026-10-14', channelId: '25', source }), [
      { id: 1, text: '기존 확정 자막', at, k: '100:1' },
    ], '미완성 초안(final=0)은 정리하고 확정 자막만 보존한다');
    assert.deepEqual(store.sourcesForChannel('25'), [source]);
    assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get(), undefined, '레거시 messages 테이블을 삭제한다');
    const cols = store.db.prepare('PRAGMA table_info(captions)').all().map(col => col.name);
    assert.equal(cols.includes('source'), false, 'captions에서 중복 source URL 컬럼을 제거한다');
    assert.equal(cols.includes('final'), false, 'captions에서 불필요한 final 컬럼을 제거한다');
    const migratedRow = store.db.prepare('SELECT segment_key FROM captions WHERE id=1').get();
    assert.equal(migratedRow.segment_key.includes(source), false, '기존 행의 segment_key에서도 URL을 제거한다');
    store.close();
    store = new CaptionStore(filename);
    assert.deepEqual(store.rows({ day: '2026-10-14', channelId: '25', source }), [
      { id: 1, text: '기존 확정 자막', at, k: '100:1' },
    ], '두 번째 기동부터는 추가 마이그레이션 없이 그대로 동작한다');
  } finally {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(filename + suffix, { force: true });
  }
});
