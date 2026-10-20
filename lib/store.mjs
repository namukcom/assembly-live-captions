import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseCaption, segmentKey, seoulDay, seoulSlot } from './caption-format.mjs';

function captionRow(row) {
  if (!row) return null;
  return {
    id: row.id, key: row.segment_key, day: row.day, text: row.text,
    final: true, at: row.first_at, updatedAt: row.last_at, revision: row.last_message_id,
  };
}

function shortSegmentKey(rawKey) {
  try {
    const parts = JSON.parse(rawKey);
    if (!Array.isArray(parts) || parts.length < 4 || parts.at(-2) === 'message') return null;
    return segmentKey(parts.at(-2), parts.at(-1));
  } catch {
    return null;
  }
}

function snapshotCaptionRow(row, includeKey) {
  const item = { id: row.id, text: row.text, at: row.first_at };
  if (includeKey) {
    const k = shortSegmentKey(row.segment_key);
    if (k) item.k = k;
  }
  return item;
}

function snapshotRecordRow(row) {
  return { id: row.id, at: row.first_at, text: row.text };
}

function compactLegacySegmentKey(rawKey, day, sourceId, channelId, id) {
  const scopeKey = channelId ? `c:${channelId}` : `s:${sourceId}`;
  try {
    const parts = JSON.parse(rawKey);
    if (Array.isArray(parts) && parts.length >= 4) {
      return JSON.stringify([scopeKey, day, parts.at(-2), parts.at(-1)]);
    }
  } catch {}
  return JSON.stringify([scopeKey, day, 'message', id]);
}

export class CaptionStore {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS channel_sources (
        channel_id TEXT NOT NULL,
        source_id INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(channel_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS captions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        segment_key TEXT NOT NULL UNIQUE,
        day TEXT NOT NULL,
        source_id INTEGER NOT NULL DEFAULT 0,
        channel_id TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        first_at TEXT NOT NULL,
        last_at TEXT NOT NULL,
        last_message_id INTEGER NOT NULL
      );
    `);
    this.ensureSourceStmt = this.db.prepare(`
      INSERT INTO sources(url) VALUES (?)
      ON CONFLICT(url) DO UPDATE SET url=excluded.url
      RETURNING id
    `);
    this.findSourceStmt = this.db.prepare('SELECT id FROM sources WHERE url=?');
    this.sourceIds = new Map();
    this.migrateLegacySchema(filename);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS captions_day_id ON captions(day, id);
      CREATE INDEX IF NOT EXISTS captions_day_source_id ON captions(day, source_id, id);
      CREATE INDEX IF NOT EXISTS captions_day_channel_id ON captions(day, channel_id, id);
      CREATE INDEX IF NOT EXISTS captions_day_message_id ON captions(day, last_message_id);
    `);
    this.upsertCaption = this.db.prepare(`
      INSERT INTO captions(segment_key, day, source_id, channel_id, text, first_at, last_at, last_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(segment_key) DO UPDATE SET text=excluded.text,
        source_id=excluded.source_id, channel_id=excluded.channel_id,
        last_at=excluded.last_at, last_message_id=excluded.last_message_id
      RETURNING *
    `);
    this.cursorStmt = this.db.prepare('SELECT COALESCE(MAX(last_message_id), 0) AS id FROM captions');
    this.rememberSourceStmt = this.db.prepare(`
      INSERT INTO channel_sources(channel_id, source_id, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(channel_id, source_id) DO UPDATE SET updated_at=excluded.updated_at
    `);
    this.sourcesStmt = this.db.prepare(`
      SELECT s.url AS source FROM channel_sources cs
      JOIN sources s ON s.id = cs.source_id
      WHERE cs.channel_id=?
      ORDER BY cs.updated_at, s.url
    `);
    this.datesStmt = this.db.prepare('SELECT day, COUNT(*) AS count FROM captions GROUP BY day ORDER BY day DESC');
    this.recordsStmt = this.db.prepare('SELECT id, first_at, day, text FROM captions WHERE day=? AND last_message_id<=? ORDER BY id');
    this.statements = new Map();
    this.channelSources = new Map();
  }

  migrateLegacySchema(filename) {
    const hasMessagesTable = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get());
    const channelSourceColumns = this.db.prepare('PRAGMA table_info(channel_sources)').all();
    const hasLegacyChannelSources = channelSourceColumns.some(column => column.name === 'source');
    const captionColumns = this.db.prepare('PRAGMA table_info(captions)').all();
    const hasLegacyCaptions = !captionColumns.some(column => column.name === 'source_id') ||
      captionColumns.some(column => column.name === 'source' || column.name === 'final');
    if (!hasMessagesTable && !hasLegacyChannelSources && !hasLegacyCaptions) return;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (hasMessagesTable) {
        this.db.exec('DROP TABLE messages');
      }
      if (hasLegacyChannelSources) {
        const legacyMappings = this.db.prepare('SELECT channel_id, source, updated_at FROM channel_sources').all();
        this.db.exec(`
          DROP TABLE channel_sources;
          CREATE TABLE channel_sources (
            channel_id TEXT NOT NULL,
            source_id INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(channel_id, source_id)
          );
        `);
        const insertMapping = this.db.prepare(`
          INSERT INTO channel_sources(channel_id, source_id, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(channel_id, source_id) DO UPDATE SET updated_at=excluded.updated_at
        `);
        for (const row of legacyMappings) {
          if (row.channel_id && row.source) {
            insertMapping.run(row.channel_id, this.ensureSourceId(row.source), row.updated_at);
          }
        }
      }
      if (hasLegacyCaptions) {
        const hasSourceCol = captionColumns.some(column => column.name === 'source');
        const hasSourceIdCol = captionColumns.some(column => column.name === 'source_id');
        const hasChannelIdCol = captionColumns.some(column => column.name === 'channel_id');
        const hasFinalCol = captionColumns.some(column => column.name === 'final');
        const whereFinal = hasFinalCol ? 'WHERE final IS NULL OR final != 0' : '';
        const legacyRows = this.db.prepare(`SELECT * FROM captions ${whereFinal} ORDER BY id`).all();
        this.db.exec(`
          DROP TABLE captions;
          CREATE TABLE captions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            segment_key TEXT NOT NULL UNIQUE,
            day TEXT NOT NULL,
            source_id INTEGER NOT NULL DEFAULT 0,
            channel_id TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL,
            first_at TEXT NOT NULL,
            last_at TEXT NOT NULL,
            last_message_id INTEGER NOT NULL
          );
        `);
        const insertCaption = this.db.prepare(`
          INSERT INTO captions(id, segment_key, day, source_id, channel_id, text, first_at, last_at, last_message_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(segment_key) DO UPDATE SET text=excluded.text,
            source_id=excluded.source_id, channel_id=excluded.channel_id,
            last_at=excluded.last_at, last_message_id=excluded.last_message_id
        `);
        for (const row of legacyRows) {
          if (!row.text?.trim()) continue;
          let sourceId = hasSourceIdCol && row.source_id ? Number(row.source_id) : 0;
          if (!sourceId) {
            let url = hasSourceCol && row.source ? row.source : null;
            if (!url) {
              try {
                const parts = JSON.parse(row.segment_key);
                url = parts.find(item => typeof item === 'string' && item.includes('://')) ||
                  (typeof parts[0] === 'string' ? parts[0] : null);
              } catch {}
            }
            if (url) sourceId = this.ensureSourceId(url);
          }
          const channelId = hasChannelIdCol && row.channel_id ? String(row.channel_id) : '';
          const key = compactLegacySegmentKey(row.segment_key, row.day, sourceId, channelId, row.id);
          insertCaption.run(row.id, key, row.day, sourceId, channelId, row.text, row.first_at, row.last_at, row.last_message_id);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (filename !== ':memory:') {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
      } catch {}
    }
  }

  ensureSourceId(source) {
    if (!source) return 0;
    let id = this.sourceIds.get(source);
    if (!id) {
      id = Number(this.ensureSourceStmt.get(source).id);
      this.sourceIds.set(source, id);
    }
    return id;
  }

  findSourceId(source) {
    if (!source) return 0;
    let id = this.sourceIds.get(source);
    if (!id) {
      const row = this.findSourceStmt.get(source);
      if (!row) return 0;
      id = Number(row.id);
      this.sourceIds.set(source, id);
    }
    return id;
  }

  statement(sql) {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      if (this.statements.size >= 64) this.statements.clear();
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  ingest(raw, source, at = new Date().toISOString(), channelId = '') {
    const day = seoulDay(at);
    const parsed = parseCaption(raw);
    if (!parsed || parsed.final === false) {
      return { cursor: this.cursor(), day, caption: null, record: null };
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const sourceId = this.ensureSourceId(source);
      const id = this.cursor() + 1;
      const scopeKey = channelId ? `c:${channelId}` : `s:${sourceId}`;
      const key = parsed.segment === null ? JSON.stringify([scopeKey, day, 'message', id]) :
        JSON.stringify([scopeKey, day, parsed.offset, parsed.segment]);
      const caption = captionRow(this.upsertCaption.get(key, day, sourceId, channelId, parsed.text, at, at, id));
      this.db.exec('COMMIT');
      return { cursor: id, day, caption, record: { id, at, day, text: parsed.text } };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  cursor() { return this.cursorStmt.get().id; }

  rememberChannelSource(channelId, source, at = new Date().toISOString()) {
    if (!channelId || !source) return;
    const sourceId = this.ensureSourceId(source);
    this.rememberSourceStmt.run(channelId, sourceId, at);
    this.channelSources.delete(String(channelId));
  }

  sourcesForChannel(channelId) {
    const key = String(channelId);
    let cached = this.channelSources.get(key);
    if (!cached) {
      cached = this.sourcesStmt.all(channelId).map(row => row.source);
      this.channelSources.set(key, cached);
    }
    return [...cached];
  }

  dates() {
    return this.datesStmt.all();
  }

  rows({ day, mode = 'clean', after = 0, limit = 1000, source = null, channelId = null, historySources = [] }) {
    const { condition: scopeCondition, args: scopeArgs } = this.scope(channelId, source, historySources);
    const args = [day, after, ...scopeArgs, limit];
    const list = this.statement(`SELECT * FROM captions WHERE day=? AND id>?${scopeCondition} ORDER BY id LIMIT ?`)
      .all(...args);
    if (mode === 'raw') return list.map(snapshotRecordRow);
    const tailStart = Math.max(0, list.length - 20);
    return list.map((row, index) => snapshotCaptionRow(row, after > 0 || index >= tailStart));
  }

  *records(day) {
    const end = this.cursor();
    for (const row of this.recordsStmt.iterate(day, end)) {
      yield { id: row.id, at: row.first_at, day: row.day, text: row.text };
    }
  }

  *textRows(day, _mode, source = null, channelId = null, historySources = []) {
    const { condition: scopeCondition, args: scopeArgs } = this.scope(channelId, source, historySources);
    let prevSlot = null;
    for (const row of this.statement(`SELECT text, first_at FROM captions WHERE day=?${scopeCondition} ORDER BY id`).iterate(day, ...scopeArgs)) {
      const slot = seoulSlot(row.first_at);
      if (slot && prevSlot && slot !== prevSlot) yield `─── ${slot} ───`;
      if (slot) prevSlot = slot;
      yield row.text;
    }
  }

  eventsAfter(cursor, day, source = null, limit = 5001, channelId = null, historySources = []) {
    const { condition: scopeCondition, args: scopeArgs } = this.scope(channelId, source, historySources);
    const rows = this.statement(`SELECT * FROM captions WHERE last_message_id>? AND day=?${scopeCondition} ORDER BY last_message_id LIMIT ?`)
      .all(cursor, day, ...scopeArgs, limit);
    return rows.map(row => {
      const caption = captionRow(row);
      return {
        cursor: row.last_message_id,
        day,
        record: { id: row.last_message_id, at: row.last_at, day: row.day, text: row.text },
        caption,
      };
    });
  }

  scope(channelId, source, historySources = []) {
    if (!channelId) {
      if (source === null) return { condition: '', args: [] };
      const sourceId = this.findSourceId(source);
      return sourceId ? { condition: ' AND source_id=?', args: [sourceId] } : { condition: ' AND 0', args: [] };
    }
    const sourceIds = [...new Set([source, ...historySources].filter(Boolean).map(url => this.findSourceId(url)).filter(Boolean))];
    if (!sourceIds.length) return { condition: ' AND channel_id=?', args: [channelId] };
    const placeholders = sourceIds.map(() => '?').join(',');
    return { condition: ` AND (channel_id=? OR (channel_id='' AND source_id IN (${placeholders})))`, args: [channelId, ...sourceIds] };
  }

  close() { this.db.close(); }
}
