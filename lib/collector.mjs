import { parseCaption } from './caption-format.mjs';

export class CaptionCollector {
  constructor({ source, channelId = '', store, onEvent = () => {}, onStatus = () => {},
    WebSocketClass = WebSocket, reconnectBaseMs = 1000, idleMs = 300000,
    logger = entry => console.info(JSON.stringify(entry)) }) {
    Object.assign(this, { source, channelId, store, onEvent, onStatus, WebSocketClass, reconnectBaseMs, idleMs, logger });
    this.running = false;
    this.socket = null;
    this.paused = false;
    this.failures = 0;
    this.pendingDrafts = new Map();
    this.recentFinals = new Set();
    this.state = { state: 'stopped', lastReceivedAt: null, nextRetryAt: null };
  }

  report(changes) { const previous = this.state.state;
    this.state = { ...this.state, ...changes };
    if (this.state.state !== previous) {
      this.diagnostic('collector-state', { state: this.state.state, reason: this.state.lastError ?? null });
      this.onStatus({ state: this.state.state });
    }
  }

  diagnostic(event, extra = {}) {
    try {
      this.logger({ at: new Date().toISOString(), event, channelId: this.channelId, source: this.source,
        lastReceivedAt: this.state.lastReceivedAt, lastFinalAt: this.state.lastFinalAt ?? null,
        pendingDraftCount: this.pendingDrafts.size, ...extra });
    } catch { /* A diagnostic sink failure must not interrupt caption storage. */ }
  }

  trackMessage(raw, saved, at) {
    if (saved.caption) {
      const parts = JSON.parse(saved.caption.key);
      const key = parts.at(-2) === 'message' ? JSON.stringify([saved.day, 'unsegmented']) :
        JSON.stringify([saved.day, parts.at(-2), parts.at(-1)]);
      this.pendingDrafts.delete(key);
      if (parts.at(-2) !== 'message') this.recentFinals.add(key);
      if (this.recentFinals.size > 100) this.recentFinals.delete(this.recentFinals.values().next().value);
      this.state.lastFinalAt = at;
      if (this.paused) this.diagnostic('final-during-pause', {
        captionId: saved.caption.id, cursor: saved.cursor, key: saved.caption.key,
        text: saved.caption.text.slice(0, 500),
      });
      return;
    }
    const parsed = parseCaption(raw);
    if (!parsed || parsed.final !== false) return;
    const key = parsed.segment === null ? JSON.stringify([saved.day, 'unsegmented']) :
      JSON.stringify([saved.day, parsed.offset, parsed.segment]);
    if (this.recentFinals.has(key)) return;
    this.pendingDrafts.delete(key);
    this.pendingDrafts.set(key, { at, segment: parsed.segment, offset: parsed.offset,
      text: parsed.text.slice(0, 500), rawPreview: raw.slice(0, 2048), truncated: raw.length > 2048 });
    if (this.pendingDrafts.size > 20) this.pendingDrafts.delete(this.pendingDrafts.keys().next().value);
  }

  start() { if (!this.running) { this.running = true; this.connect(); } }

  connect() {
    if (!this.running) return;
    clearTimeout(this.retryTimer);
    this.report({ state: 'connecting', nextRetryAt: null });
    let socket;
    try { socket = new this.WebSocketClass(this.source, 'echo-protocol'); } catch (error) {
      this.retry(error.message); return;
    }
    this.socket = socket;
    this.handshakeTimer = setTimeout(() => this.disconnect(socket, '연결 시간 초과'), 15000);
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      clearTimeout(this.handshakeTimer);
      this.report({ state: 'connected', lastError: null });
      this.armIdle(socket);
    });
    socket.addEventListener('message', event => {
      if (this.socket !== socket || typeof event.data !== 'string') return;
      if (Buffer.byteLength(event.data) > 1024 * 1024) {
        this.disconnect(socket, '자막 메시지 크기 초과'); return;
      }
      try {
        const at = new Date().toISOString();
        const saved = this.store.ingest(event.data, this.source, at, this.channelId);
        this.failures = 0;
        this.report({ state: 'connected', lastReceivedAt: at, lastError: null });
        this.trackMessage(event.data, saved, at);
        this.onEvent(saved);
        this.armIdle(socket);
      } catch (error) {
        // Exit on a storage failure: Docker restarts us rather than silently dropping captions.
        console.error('자막 저장 실패:', error.message);
        this.stop('자막 저장 실패');
        this.onFatal?.(error);
      }
    });
    socket.addEventListener('error', () => this.disconnect(socket, '자막 서버 연결 실패'));
    socket.addEventListener('close', event => this.disconnect(socket, `연결 종료 (${event.code})`));
  }

  armIdle(socket) {
    clearTimeout(this.idleTimer);
    if (this.paused) return;
    this.idleTimer = setTimeout(() => this.disconnect(socket, '장시간 수신 없음 · 재연결'), this.idleMs);
  }

  disconnect(socket, reason) {
    if (this.socket !== socket) return;
    this.diagnostic('collector-disconnect', { reason, pendingDrafts: [...this.pendingDrafts.values()] });
    this.socket = null;
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.idleTimer);
    try { socket.close(); } catch {}
    if (this.running) this.retry(reason);
  }

  retry(reason) {
    if (!this.running) return;
    const delay = Math.min(60000, this.reconnectBaseMs * 2 ** Math.min(this.failures++, 6));
    this.report({ state: 'reconnecting', lastError: reason, nextRetryAt: new Date(Date.now() + delay).toISOString() });
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  pause(reason = '') {
    if (this.paused) return;
    this.paused = true;
    clearTimeout(this.idleTimer);
    this.report({ paused: true });
    this.diagnostic('collector-paused', { reason, pendingDrafts: [...this.pendingDrafts.values()] });
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.report({ paused: false });
    this.diagnostic('collector-resumed');
    if (this.socket && this.state.state === 'connected') this.armIdle(this.socket);
  }

  stop(reason = '수집 중지') {
    if (this.running || this.socket) this.diagnostic('collector-stopped', { reason, pendingDrafts: [...this.pendingDrafts.values()] });
    this.running = false;
    this.paused = false;
    clearTimeout(this.retryTimer); clearTimeout(this.handshakeTimer); clearTimeout(this.idleTimer);
    const socket = this.socket; this.socket = null;
    try { socket?.close(); } catch {}
    this.report({ state: 'stopped', paused: false, nextRetryAt: null });
  }
}
