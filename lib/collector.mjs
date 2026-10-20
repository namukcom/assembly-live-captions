export class CaptionCollector {
  constructor({ source, channelId = '', store, onEvent = () => {}, onStatus = () => {},
    WebSocketClass = WebSocket, reconnectBaseMs = 1000, idleMs = 300000 }) {
    Object.assign(this, { source, channelId, store, onEvent, onStatus, WebSocketClass, reconnectBaseMs, idleMs });
    this.running = false;
    this.socket = null;
    this.failures = 0;
    this.state = { state: 'stopped', lastReceivedAt: null, nextRetryAt: null };
  }

  report(changes) { const previous = this.state.state;
    this.state = { ...this.state, ...changes };
    if (this.state.state !== previous) this.onStatus({ state: this.state.state });
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
        this.onEvent(saved);
        this.armIdle(socket);
      } catch (error) {
        // Exit on a storage failure: Docker restarts us rather than silently dropping captions.
        console.error('자막 저장 실패:', error.message);
        this.stop();
        this.onFatal?.(error);
      }
    });
    socket.addEventListener('error', () => this.disconnect(socket, '자막 서버 연결 실패'));
    socket.addEventListener('close', event => this.disconnect(socket, `연결 종료 (${event.code})`));
  }

  armIdle(socket) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.disconnect(socket, '장시간 수신 없음 · 재연결'), this.idleMs);
  }

  disconnect(socket, reason) {
    if (this.socket !== socket) return;
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

  stop() {
    this.running = false;
    clearTimeout(this.retryTimer); clearTimeout(this.handshakeTimer); clearTimeout(this.idleTimer);
    const socket = this.socket; this.socket = null;
    try { socket?.close(); } catch {}
    this.report({ state: 'stopped', nextRetryAt: null });
  }
}
