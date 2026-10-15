import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseCaption, seoulDay } from './caption-format.mjs';

function captionRow(row) {
  if (!row) return null;
  return {
    id: row.id, key: row.segment_key, day: row.day, text: row.text,
    final: row.final === null ? null : Boolean(row.final), at: row.first_at,
    updatedAt: row.last_at, revision: row.last_message_id,
  };
}

function recordRow(row) {
  return { id: row.id, at: row.received_at, day: row.day, source: row.source, channelId: row.channel_id || '',
    raw: row.raw, text: parseCaption(row.raw)?.text ?? '', segmentId: row.segment_id };
}

export class CaptionStore {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL,
        day TEXT NOT NULL, source TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '', raw TEXT NOT NULL, segment_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS messages_day_id ON messages(day, id);
      CREATE TABLE IF NOT EXISTS captions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, segment_key TEXT NOT NULL UNIQUE,
        day TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', channel_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, final INTEGER,
        first_at TEXT NOT NULL, last_at TEXT NOT NULL, last_message_id INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS captions_day_id ON captions(day, id);
      CREATE TABLE IF NOT EXISTS channel_sources (
        channel_id TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(channel_id, source)
      );
    `);
    const captionColumns = this.db.prepare('PRAGMA table_info(captions)').all();
    if (!captionColumns.some(column => column.name === 'source')) {
      this.db.exec("ALTER TABLE captions ADD COLUMN source TEXT NOT NULL DEFAULT ''");
      const update = this.db.prepare('UPDATE captions SET source=? WHERE id=?');
      for (const row of this.db.prepare("SELECT id, segment_key FROM captions WHERE source='' ").all()) {
        try { const [source] = JSON.parse(row.segment_key); if (typeof source === 'string') update.run(source, row.id); } catch {}
      }
    }
    if (!captionColumns.some(column => column.name === 'channel_id')) {
      this.db.exec("ALTER TABLE captions ADD COLUMN channel_id TEXT NOT NULL DEFAULT ''");
    }
    const messageColumns = this.db.prepare('PRAGMA table_info(messages)').all();
    if (!messageColumns.some(column => column.name === 'channel_id')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN channel_id TEXT NOT NULL DEFAULT ''");
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS captions_day_source_id ON captions(day, source, id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS captions_day_channel_id ON captions(day, channel_id, id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS messages_day_channel_id ON messages(day, channel_id, id)');
    this.insertMessage = this.db.prepare('INSERT INTO messages(received_at, day, source, channel_id, raw) VALUES (?, ?, ?, ?, ?)');
    this.upsertCaption = this.db.prepare(`
      INSERT INTO captions(segment_key, day, source, channel_id, text, final, first_at, last_at, last_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(segment_key) DO UPDATE SET text=excluded.text, final=excluded.final,
        channel_id=excluded.channel_id, last_at=excluded.last_at, last_message_id=excluded.last_message_id
      RETURNING *
    `);
    this.linkMessage = this.db.prepare('UPDATE messages SET segment_id=? WHERE id=?');
    this.byId = this.db.prepare('SELECT * FROM captions WHERE id=?');
  }

  ingest(raw, source, at = new Date().toISOString(), channelId = '') {
    const day = seoulDay(at);
    const parsed = parseCaption(raw);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const id = Number(this.insertMessage.run(at, day, source, channelId, raw).lastInsertRowid);
      let caption = null;
      if (parsed) {
        // Number and stream offset identify a draft, even when its wording is completely replaced.
        const identity = channelId ? [channelId, source] : [source];
        const key = parsed.segment === null ? JSON.stringify([...identity, day, 'message', id]) :
          JSON.stringify([...identity, day, parsed.offset, parsed.segment]);
        caption = captionRow(this.upsertCaption.get(key, day, source, channelId, parsed.text,
          parsed.final === null ? null : Number(parsed.final), at, at, id));
        this.linkMessage.run(caption.id, id);
      }
      this.db.exec('COMMIT');
      return { cursor: id, day, caption, record: { id, at, day, source, channelId, raw,
        text: parsed?.text ?? '', segmentId: caption?.id ?? null } };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  cursor() { return this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages').get().id; }

  rememberChannelSource(channelId, source, at = new Date().toISOString()) {
    if (!channelId || !source) return;
    this.db.prepare(`INSERT INTO channel_sources(channel_id, source, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(channel_id, source) DO UPDATE SET updated_at=excluded.updated_at`).run(channelId, source, at);
  }

  sourcesForChannel(channelId) {
    return this.db.prepare('SELECT source FROM channel_sources WHERE channel_id=? ORDER BY updated_at, source')
      .all(channelId).map(row => row.source);
  }

  dates() {
    return this.db.prepare('SELECT day, COUNT(*) AS count FROM captions GROUP BY day ORDER BY day DESC').all();
  }

  rows({ day, mode = 'clean', after = 0, limit = 1000, source = null, channelId = null, historySources = [] }) {
    const { condition: scopeCondition, args: scopeArgs } = this.scope(channelId, source, historySources);
    const args = [day, after, ...scopeArgs, limit];
    if (mode === 'raw') {
      return this.db.prepare(`SELECT * FROM messages WHERE day=? AND id>?${scopeCondition} ORDER BY id LIMIT ?`)
        .all(...args).map(recordRow);
    }
    const finalCondition = mode === 'final' ? ' AND (final=1 OR final IS NULL)' : '';
    return this.db.prepare(`SELECT * FROM captions WHERE day=? AND id>?${scopeCondition}${finalCondition} ORDER BY id LIMIT ?`)
      .all(...args).map(captionRow);
  }

  *records(day) {
    const end = this.cursor();
    for (const row of this.db.prepare('SELECT * FROM messages WHERE day=? AND id<=? ORDER BY id').iterate(day, end)) {
      yield recordRow(row);
    }
  }

  *textRows(day, mode, source = null, channelId = null, historySources = []) {
    const condition = mode === 'final' ? ' AND (final=1 OR final IS NULL)' : '';
    const { condition: scopeCondition, args: scopeArgs } = this.scope(channelId, source, historySources);
    for (const row of this.db.prepare(`SELECT text FROM captions WHERE day=?${scopeCondition}${condition} ORDER BY id`).iterate(day, ...scopeArgs)) {
      yield row.text;
    }
  }

  eventsAfter(cursor, day, source = null, limit = 5001, channelId = null, historySources = []) {
    const cache = new Map();
    const { condition: scopeCondition, args: scopeArgs } = this.scope(channelId, source, historySources);
    return this.db.prepare(`SELECT * FROM messages WHERE id>? AND day=?${scopeCondition} ORDER BY id LIMIT ?`)
      .all(cursor, day, ...scopeArgs, limit).map(row => {
        if (row.segment_id !== null && !cache.has(row.segment_id)) {
          cache.set(row.segment_id, captionRow(this.byId.get(row.segment_id)));
        }
        return { cursor: row.id, day, record: recordRow(row), caption: cache.get(row.segment_id) ?? null };
      });
  }

  scope(channelId, source, historySources = []) {
    if (!channelId) return source === null ? { condition: '', args: [] } : { condition: ' AND source=?', args: [source] };
    const sources = [...new Set([source, ...historySources].filter(Boolean))];
    if (!sources.length) return { condition: ' AND channel_id=?', args: [channelId] };
    const placeholders = sources.map(() => '?').join(',');
    return { condition: ` AND (channel_id=? OR (channel_id='' AND source IN (${placeholders})))`, args: [channelId, ...sources] };
  }

  close() { this.db.close(); }
}
