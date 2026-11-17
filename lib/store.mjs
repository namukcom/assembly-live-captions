import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseCaption, segmentKey, seoulDay, seoulSlot } from './caption-format.mjs';

function captionRow(row) {
  if (!row) return null;
  return {
    id: row.id, key: row.segment_key, day: row.day, text: row.text,
    final: true, at: row.first_at,
  };
}

function shortSegmentKey(rawKey) {
  if (!rawKey) return null;
  if (rawKey.startsWith('[')) {
    try {
      const parts = JSON.parse(rawKey);
      if (!Array.isArray(parts) || parts.length < 4 || parts.at(-2) === 'message') return null;
      return segmentKey(parts.at(-2), parts.at(-1));
    } catch {
      return null;
    }
  }
  const sep = rawKey.indexOf('|');
  if (sep === -1) return null;
  const key = rawKey.slice(sep + 1);
  return key.startsWith('m:') ? null : key;
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

function normalizeSubject(value) {
  return String(value || '').replace(/\s*\[\d{1,2}:\d{2}\]\s*$/, '').trim();
}

function compactSegmentKey(rawKey, sourceId, channelId, id) {
  const scope = channelId || `s${sourceId}`;
  if (rawKey && !rawKey.startsWith('[')) {
    const sep = rawKey.indexOf('|');
    if (sep !== -1) return `${scope}|${rawKey.slice(sep + 1)}`;
  }
  try {
    const parts = JSON.parse(rawKey);
    if (Array.isArray(parts) && parts.length >= 4 && parts.at(-2) !== 'message') {
      return `${scope}|${segmentKey(parts.at(-2), parts.at(-1))}`;
    }
  } catch {}
  return `${scope}|m:${id}`;
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
        id INTEGER PRIMARY KEY,
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
        day TEXT NOT NULL,
        segment_key TEXT NOT NULL,
        source_id INTEGER NOT NULL DEFAULT 0,
        channel_id TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        first_at TEXT NOT NULL,
        UNIQUE(day, segment_key)
      );
    `);
    this.insertSourceStmt = this.db.prepare('INSERT INTO sources(url) VALUES (?) RETURNING id');
    this.findSourceStmt = this.db.prepare('SELECT id FROM sources WHERE url=?');
    this.sourceIds = new Map();
    this.migrateLegacySchema(filename);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS captions_day_id ON captions(day, id);
      CREATE INDEX IF NOT EXISTS captions_day_source_id ON captions(day, source_id, id);
      CREATE INDEX IF NOT EXISTS captions_day_channel_id ON captions(day, channel_id, id);
      CREATE TABLE IF NOT EXISTS channels (
        channel_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        full_name TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channel_meetings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        schedule_code TEXT NOT NULL DEFAULT '',
        subject TEXT NOT NULL DEFAULT '',
        first_at TEXT NOT NULL,
        last_at TEXT NOT NULL,
        UNIQUE(day, channel_id, schedule_code, subject)
      );
      CREATE INDEX IF NOT EXISTS channel_meetings_day_channel ON channel_meetings(day, channel_id, id);
    `);
    this.upsertCaption = this.db.prepare(`
      INSERT INTO captions(day, segment_key, source_id, channel_id, text, first_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, segment_key) DO UPDATE SET text=excluded.text,
        source_id=excluded.source_id, channel_id=excluded.channel_id
      RETURNING *
    `);
    this.cursorStmt = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM captions');
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
    this.recordsStmt = this.db.prepare('SELECT id, first_at, day, text FROM captions WHERE day=? AND id<=? ORDER BY id');
    this.hasEmptyChannelId = Boolean(this.db.prepare("SELECT EXISTS(SELECT 1 FROM captions WHERE channel_id='') AS has").get().has);
    this.upsertChannelStmt = this.db.prepare(`
      INSERT INTO channels(channel_id, name, full_name, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET name=excluded.name,
        full_name=CASE WHEN excluded.full_name != '' THEN excluded.full_name ELSE channels.full_name END,
        updated_at=excluded.updated_at
    `);
    this.upsertMeetingStmt = this.db.prepare(`
      INSERT INTO channel_meetings(day, channel_id, schedule_code, subject, first_at, last_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, channel_id, schedule_code, subject) DO UPDATE SET last_at=excluded.last_at
    `);
    this.statements = new Map();
    this.channelSources = new Map();
    this.channelMetaCache = new Map();
    this.meetingMetaCache = new Map();
  }

  migrateLegacySchema(filename) {
    const hasMessagesTable = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get());
    const channelSourceColumns = this.db.prepare('PRAGMA table_info(channel_sources)').all();
    const hasLegacyChannelSources = channelSourceColumns.some(column => column.name === 'source');
    const captionColumns = this.db.prepare('PRAGMA table_info(captions)').all();
    const hasLegacyCaptions = !captionColumns.some(column => column.name === 'source_id') ||
      captionColumns.some(column => ['source', 'final', 'last_at', 'last_message_id'].includes(column.name));
    if (!hasMessagesTable && !hasLegacyChannelSources && !hasLegacyCaptions) return;

    if (filename !== ':memory:') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${filename}.bak-${stamp}`;
      this.db.prepare('VACUUM INTO ?').run(backupPath);
    }

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
        const uniqueSourceChannel = new Map();
        const ambiguousSources = new Set();
        for (const mapping of this.db.prepare('SELECT channel_id, source_id FROM channel_sources').all()) {
          if (ambiguousSources.has(mapping.source_id)) continue;
          const prev = uniqueSourceChannel.get(mapping.source_id);
          if (prev && prev !== mapping.channel_id) {
            uniqueSourceChannel.delete(mapping.source_id);
            ambiguousSources.add(mapping.source_id);
          } else {
            uniqueSourceChannel.set(mapping.source_id, mapping.channel_id);
          }
        }
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
            day TEXT NOT NULL,
            segment_key TEXT NOT NULL,
            source_id INTEGER NOT NULL DEFAULT 0,
            channel_id TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL,
            first_at TEXT NOT NULL,
            UNIQUE(day, segment_key)
          );
        `);
        const insertCaption = this.db.prepare(`
          INSERT INTO captions(id, day, segment_key, source_id, channel_id, text, first_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(day, segment_key) DO UPDATE SET text=excluded.text,
            source_id=excluded.source_id, channel_id=excluded.channel_id
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
          let channelId = hasChannelIdCol && row.channel_id ? String(row.channel_id) : '';
          if (!channelId && sourceId) channelId = uniqueSourceChannel.get(sourceId) || '';
          const key = compactSegmentKey(row.segment_key, sourceId, channelId, row.id);
          insertCaption.run(row.id, row.day, key, sourceId, channelId, row.text, row.first_at);
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
      const existing = this.findSourceStmt.get(source);
      id = existing ? Number(existing.id) : Number(this.insertSourceStmt.get(source).id);
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
      if (!channelId) this.hasEmptyChannelId = true;
      const scope = channelId || `s${sourceId}`;
      const seg = parsed.segment === null ? `m:${this.cursor() + 1}` : segmentKey(parsed.offset, parsed.segment);
      const key = `${scope}|${seg}`;
      const caption = captionRow(this.upsertCaption.get(day, key, sourceId, channelId, parsed.text, at));
      this.db.exec('COMMIT');
      return { cursor: caption.id, day, caption, record: { id: caption.id, at, day, text: parsed.text } };
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

  rememberChannelMeta({ channelId, name = '', fullName = '', subject = '', scheduleCode = '', scheduled = false, at = new Date().toISOString() }) {
    if (!channelId) return;
    const id = String(channelId);
    const cleanName = String(name || '').trim();
    const cleanFullName = String(fullName || '').trim();
    if (cleanName) {
      const cached = this.channelMetaCache.get(id);
      if (!cached || cached.name !== cleanName || (cleanFullName && cached.fullName !== cleanFullName)) {
        this.upsertChannelStmt.run(id, cleanName, cleanFullName, at);
        this.channelMetaCache.set(id, { name: cleanName, fullName: cleanFullName || cached?.fullName || '' });
      }
    }
    if (!scheduled) return;
    const cleanSubject = normalizeSubject(subject);
    const cleanSchedule = String(scheduleCode || '').trim();
    if (!cleanSubject && !cleanSchedule) return;
    const day = seoulDay(at);
    const meetingKey = `${day}|${id}|${cleanSchedule}|${cleanSubject}`;
    const nowMs = Date.parse(at);
    const lastMs = this.meetingMetaCache.get(meetingKey);
    if (lastMs !== undefined && (!Number.isFinite(nowMs) || nowMs - lastMs < 5 * 60 * 1000)) return;
    this.upsertMeetingStmt.run(day, id, cleanSchedule, cleanSubject, at, at);
    if (this.meetingMetaCache.size > 200) this.meetingMetaCache.clear();
    this.meetingMetaCache.set(meetingKey, Number.isFinite(nowMs) ? nowMs : Date.now());
  }

  dates() {
    return this.datesStmt.all();
  }

  queryScoped({ columns, day, after = null, limit = null, source = null, channelId = null, historySources = [] }) {
    const idFilter = after === null ? '' : ' AND id>?';
    const baseArgs = after === null ? [day] : [day, after];
    if (!channelId) {
      if (source === null) {
        const sql = `SELECT ${columns} FROM captions WHERE day=?${idFilter} ORDER BY id${limit === null ? '' : ' LIMIT ?'}`;
        return this.statement(sql).all(...baseArgs, ...(limit === null ? [] : [limit]));
      }
      const sourceId = this.findSourceId(source);
      if (!sourceId) return [];
      const sql = `SELECT ${columns} FROM captions WHERE day=? AND source_id=?${idFilter} ORDER BY id${limit === null ? '' : ' LIMIT ?'}`;
      return this.statement(sql).all(day, sourceId, ...(after === null ? [] : [after]), ...(limit === null ? [] : [limit]));
    }
    const sourceIds = this.hasEmptyChannelId
      ? [...new Set([source, ...historySources].filter(Boolean).map(url => this.findSourceId(url)).filter(Boolean))]
      : [];
    if (!sourceIds.length) {
      const sql = `SELECT ${columns} FROM captions WHERE day=? AND channel_id=?${idFilter} ORDER BY id${limit === null ? '' : ' LIMIT ?'}`;
      return this.statement(sql).all(day, channelId, ...(after === null ? [] : [after]), ...(limit === null ? [] : [limit]));
    }
    const placeholders = sourceIds.map(() => '?').join(',');
    const branchArgs = [
      day, channelId, ...(after === null ? [] : [after]),
      day, ...sourceIds, ...(after === null ? [] : [after]),
    ];
    const sql = `SELECT ${columns} FROM (` +
      `SELECT ${columns} FROM captions WHERE day=? AND channel_id=?${idFilter}` +
      ` UNION ALL ` +
      `SELECT ${columns} FROM captions WHERE day=? AND channel_id='' AND source_id IN (${placeholders})${idFilter}` +
      `) ORDER BY id${limit === null ? '' : ' LIMIT ?'}`;
    return this.statement(sql).all(...branchArgs, ...(limit === null ? [] : [limit]));
  }

  rows({ day, mode = 'clean', after = 0, limit = 1000, source = null, channelId = null, historySources = [] }) {
    const columns = mode === 'raw' ? 'id, first_at, text' : 'id, segment_key, text, first_at';
    const list = this.queryScoped({ columns, day, after, limit, source, channelId, historySources });
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
    let prevSlot = null;
    for (const row of this.queryScoped({ columns: 'id, text, first_at', day, source, channelId, historySources })) {
      const slot = seoulSlot(row.first_at);
      if (slot && prevSlot && slot !== prevSlot) yield `─── ${slot} ───`;
      if (slot) prevSlot = slot;
      yield row.text;
    }
  }

  eventsAfter(cursor, day, source = null, limit = 5001, channelId = null, historySources = []) {
    const rows = this.queryScoped({ columns: 'id, day, segment_key, text, first_at', day, after: cursor, limit, source, channelId, historySources });
    return rows.map(row => {
      const caption = captionRow(row);
      return {
        cursor: row.id,
        day,
        record: { id: row.id, at: row.first_at, day: row.day, text: row.text },
        caption,
      };
    });
  }

  close() { this.db.close(); }
}
