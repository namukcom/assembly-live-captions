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
  return { id: row.id, at: row.received_at, day: row.day, source: row.source,
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
        day TEXT NOT NULL, source TEXT NOT NULL, raw TEXT NOT NULL, segment_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS messages_day_id ON messages(day, id);
      CREATE TABLE IF NOT EXISTS captions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, segment_key TEXT NOT NULL UNIQUE,
        day TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, final INTEGER,
        first_at TEXT NOT NULL, last_at TEXT NOT NULL, last_message_id INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS captions_day_id ON captions(day, id);
    `);
    const columns = this.db.prepare('PRAGMA table_info(captions)').all();
    if (!columns.some(column => column.name === 'source')) {
      this.db.exec("ALTER TABLE captions ADD COLUMN source TEXT NOT NULL DEFAULT ''");
      const update = this.db.prepare('UPDATE captions SET source=? WHERE id=?');
      for (const row of this.db.prepare("SELECT id, segment_key FROM captions WHERE source='' ").all()) {
        try { const [source] = JSON.parse(row.segment_key); if (typeof source === 'string') update.run(source, row.id); } catch {}
      }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS captions_day_source_id ON captions(day, source, id)');
    this.insertMessage = this.db.prepare('INSERT INTO messages(received_at, day, source, raw) VALUES (?, ?, ?, ?)');
    this.upsertCaption = this.db.prepare(`
      INSERT INTO captions(segment_key, day, source, text, final, first_at, last_at, last_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(segment_key) DO UPDATE SET text=excluded.text, final=excluded.final,
        last_at=excluded.last_at, last_message_id=excluded.last_message_id
      RETURNING *
    `);
    this.linkMessage = this.db.prepare('UPDATE messages SET segment_id=? WHERE id=?');
    this.byId = this.db.prepare('SELECT * FROM captions WHERE id=?');
  }

  ingest(raw, source, at = new Date().toISOString()) {
    const day = seoulDay(at);
    const parsed = parseCaption(raw);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const id = Number(this.insertMessage.run(at, day, source, raw).lastInsertRowid);
      let caption = null;
      if (parsed) {
        // Number and stream offset identify a draft, even when its wording is completely replaced.
        const key = parsed.segment === null ? JSON.stringify([source, day, 'message', id]) :
          JSON.stringify([source, day, parsed.offset, parsed.segment]);
        caption = captionRow(this.upsertCaption.get(key, day, source, parsed.text,
          parsed.final === null ? null : Number(parsed.final), at, at, id));
        this.linkMessage.run(caption.id, id);
      }
      this.db.exec('COMMIT');
      return { cursor: id, day, caption, record: { id, at, day, source, raw,
        text: parsed?.text ?? '', segmentId: caption?.id ?? null } };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  cursor() { return this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages').get().id; }

  dates() {
    return this.db.prepare('SELECT day, COUNT(*) AS count FROM captions GROUP BY day ORDER BY day DESC').all();
  }

  rows({ day, mode = 'clean', after = 0, limit = 1000, source = null }) {
    const sourceCondition = source === null ? '' : ' AND source=?';
    const args = source === null ? [day, after, limit] : [day, after, source, limit];
    if (mode === 'raw') {
      return this.db.prepare(`SELECT * FROM messages WHERE day=? AND id>?${sourceCondition} ORDER BY id LIMIT ?`)
        .all(...args).map(recordRow);
    }
    const finalCondition = mode === 'final' ? ' AND (final=1 OR final IS NULL)' : '';
    return this.db.prepare(`SELECT * FROM captions WHERE day=? AND id>?${sourceCondition}${finalCondition} ORDER BY id LIMIT ?`)
      .all(...args).map(captionRow);
  }

  *records(day) {
    const end = this.cursor();
    for (const row of this.db.prepare('SELECT * FROM messages WHERE day=? AND id<=? ORDER BY id').iterate(day, end)) {
      yield recordRow(row);
    }
  }

  *textRows(day, mode, source = null) {
    const condition = mode === 'final' ? ' AND (final=1 OR final IS NULL)' : '';
    const sourceCondition = source === null ? '' : ' AND source=?';
    const args = source === null ? [day] : [day, source];
    for (const row of this.db.prepare(`SELECT text FROM captions WHERE day=?${sourceCondition}${condition} ORDER BY id`).iterate(...args)) {
      yield row.text;
    }
  }

  eventsAfter(cursor, day, source = null, limit = 5001) {
    const cache = new Map();
    const sourceCondition = source === null ? '' : ' AND source=?';
    const args = source === null ? [cursor, day, limit] : [cursor, day, source, limit];
    return this.db.prepare(`SELECT * FROM messages WHERE id>? AND day=?${sourceCondition} ORDER BY id LIMIT ?`)
      .all(...args).map(row => {
        if (row.segment_id !== null && !cache.has(row.segment_id)) {
          cache.set(row.segment_id, captionRow(this.byId.get(row.segment_id)));
        }
        return { cursor: row.id, day, record: recordRow(row), caption: cache.get(row.segment_id) ?? null };
      });
  }

  close() { this.db.close(); }
}
