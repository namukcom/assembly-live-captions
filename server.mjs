import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { CaptionStore } from './lib/store.mjs';
import { CaptionCollector } from './lib/collector.mjs';
import { isDay, seoulDay } from './lib/caption-format.mjs';
import { defaultListUrl } from './lib/broadcast-config.mjs';
import { ChannelManager } from './lib/channel-manager.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const defaultSource = 'wss://smiai.webcast.go.kr:8091/aistt/bokji/hls';
const defaultAudio = 'https://w-assembly.hscdn.com/assembly/bokji_240p/playlist.m3u8';
const assets = new Map([
  ['/', ['captions.html', 'text/html; charset=utf-8']],
  ['/captions.html', ['captions.html', 'text/html; charset=utf-8']],
  ['/client.mjs', ['client.mjs', 'text/javascript; charset=utf-8']],
  ['/audio.mjs', ['audio.mjs', 'text/javascript; charset=utf-8']],
  ['/lib/caption-format.mjs', ['lib/caption-format.mjs', 'text/javascript; charset=utf-8']],
]);

function integer(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw Object.assign(Error('잘못된 숫자 값입니다.'), { status: 400 });
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > max) throw Object.assign(Error('숫자 범위를 벗어났습니다.'), { status: 400 });
  return result;
}

function dayParam(url) {
  const day = url.searchParams.get('date') || seoulDay();
  if (!isDay(day)) throw Object.assign(Error('날짜 형식이 올바르지 않습니다.'), { status: 400 });
  return day;
}

function modeParam(url) {
  const mode = url.searchParams.get('mode') || 'clean';
  if (!['clean', 'final', 'raw'].includes(mode)) throw Object.assign(Error('표시 방식이 올바르지 않습니다.'), { status: 400 });
  return mode;
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function event(response, name, value, cursor) {
  if (response.destroyed || response.writableEnded) return false;
  if (response.writableLength > 1024 * 1024) { response.destroy(); return false; }
  response.write(`${cursor === undefined ? '' : `id: ${cursor}\n`}event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  return true;
}

async function write(response, chunk) {
  if (response.destroyed) return false;
  if (!response.write(chunk)) {
    await new Promise(resolveWrite => {
      function finish() { response.off('drain', finish); response.off('close', finish); resolveWrite(); }
      response.once('drain', finish); response.once('close', finish);
    });
  }
  return !response.destroyed;
}

export function createApp({ filename = resolve(root, 'data/captions.sqlite'), source = defaultSource,
  audioUrl = defaultAudio, pageUrl = null, broadcast = null, liveListUrl = null,
  channelRefreshMs = 30000, fetchImpl, collect = true, WebSocketClass } = {}) {
  const store = new CaptionStore(filename);
  const subscribers = new Set();
  const sendCaption = (channelId, item) => {
    for (const sub of subscribers) {
      if (sub.channelId === channelId && sub.day === item.day) event(sub.response, 'caption', item, item.cursor);
    }
  };
  const sendStatus = (channelId, value) => {
    for (const sub of subscribers) if (sub.channelId === channelId) event(sub.response, 'status', value);
  };
  const collector = liveListUrl ? null : new CaptionCollector({ source, store, WebSocketClass,
    onEvent: item => sendCaption('default', item),
    onStatus: value => sendStatus('default', value),
  });
  const channelManager = liveListUrl ? new ChannelManager({ store, listUrl: liveListUrl,
    refreshMs: channelRefreshMs, fetchImpl, WebSocketClass,
    onEvent: sendCaption, onStatus: sendStatus,
    onFatal: () => { process.exitCode = 1; close(); },
  }) : null;

  function selectedChannel(url, requireSource = true) {
    if (!channelManager) return { id: 'default', source, audioUrl, name: broadcast?.committee || '방송', onAir: true };
    const id = url.searchParams.get('channel');
    if (!id) throw Object.assign(Error('채널을 선택하세요.'), { status: 400 });
    const channel = channelManager.get(id);
    if (!channel) throw Object.assign(Error('채널을 찾을 수 없습니다.'), { status: 404 });
    if (requireSource && !channel.source) throw Object.assign(Error('현재 재생할 수 없는 채널입니다.'), { status: 409 });
    return channel;
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', 'GET, HEAD'); json(response, 405, { error: '읽기 요청만 지원합니다.' }); return;
      }
      if (assets.has(url.pathname)) {
        const [filename, contentType] = assets.get(url.pathname);
        const content = await readFile(resolve(root, filename));
        response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        response.end(content); return;
      }
      if (url.pathname === '/api/config') {
        json(response, 200, { source: channelManager ? null : source, audioUrl: channelManager ? null : audioUrl,
          pageUrl: channelManager ? null : pageUrl, broadcast: channelManager ? null : broadcast,
          liveListUrl, channelRefreshMs, today: seoulDay(), timezone: 'Asia/Seoul' }); return;
      }
      if (url.pathname === '/api/channels') {
        if (channelManager && url.searchParams.get('refresh') === '1') await channelManager.refresh();
        const snapshot = channelManager ? channelManager.snapshot() : { channels: [{ id: 'default',
          name: broadcast?.committee || '방송', subject: broadcast?.subject || '', statusText: '', onAir: true,
          source, audioUrl, pageUrl, collector: collector.state }], refreshedAt: null, lastError: null, refreshMs: 0 };
        json(response, 200, { ...snapshot, today: seoulDay() }); return;
      }
      if (url.pathname === '/api/status' || url.pathname === '/healthz') {
        json(response, 200, channelManager ? { ...channelManager.snapshot(), cursor: store.cursor(), today: seoulDay() } :
          { ...collector.state, cursor: store.cursor(), today: seoulDay() }); return;
      }
      if (url.pathname === '/api/dates') { json(response, 200, { dates: store.dates() }); return; }
      if (url.pathname === '/api/captions') {
        const channel = selectedChannel(url, false), day = dayParam(url), mode = modeParam(url);
        const after = integer(url.searchParams.get('after'), 0);
        const limit = Math.max(1, integer(url.searchParams.get('limit'), 1000, 2000));
        const cursor = store.cursor();
        const rows = store.rows({ day, mode, after, limit, source: channel.source,
          channelId: channelManager ? channel.id : null, historySources: channel.historySources });
        json(response, 200, { channel: channel.id, day, mode, rows, cursor,
          next: rows.at(-1)?.id ?? after, hasMore: rows.length === limit }); return;
      }
      if (url.pathname === '/api/events') {
        const channel = selectedChannel(url), day = dayParam(url);
        const since = integer(request.headers['last-event-id'] ?? url.searchParams.get('since'), store.cursor());
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        if (request.method === 'HEAD') { response.end(); return; }
        response.flushHeaders();
        const sub = { response, day, channelId: channel.id, source: channel.source };
        subscribers.add(sub);
        // No asynchronous gap between replaying missed records and subscribing to new ones.
        const backlog = store.eventsAfter(since, day, channel.source, 5001,
          channelManager ? channel.id : null, channel.historySources);
        if (backlog.length > 5000 || since > store.cursor()) {
          event(response, 'reset', { reason: '서버 기록을 다시 불러옵니다.' });
        } else {
          for (const item of backlog) if (!event(response, 'caption', item, item.cursor)) break;
        }
        event(response, 'status', channelManager?.collectors.get(channel.id)?.state ?? collector?.state ?? { state: 'stopped' });
        const heartbeat = setInterval(() => {
          if (!response.destroyed && !response.writableEnded) response.write(': keepalive\n\n');
        }, 15000);
        response.on('close', () => { clearInterval(heartbeat); subscribers.delete(sub); });
        return;
      }
      if (url.pathname === '/api/export') {
        const channel = selectedChannel(url, false), day = dayParam(url), mode = modeParam(url);
        if ((url.searchParams.get('format') || 'txt') !== 'txt') {
          json(response, 400, { error: 'TXT 저장만 지원합니다.' }); return;
        }
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="captions-${channel.id}-${day}.txt"`, 'Cache-Control': 'no-store' });
        await write(response, '\uFEFF');
        for (const text of store.textRows(day, mode, channel.source,
          channelManager ? channel.id : null, channel.historySources)) if (!await write(response, `${text}\n\n`)) return;
        response.end();
        return;
      }
      // Audio is deliberately absent: clients fetch the original broadcast directly.
      json(response, 404, { error: '페이지를 찾을 수 없습니다.' });
    } catch (error) {
      console.error('요청 처리 실패:', error.message);
      if (!response.headersSent) json(response, error.status || 500, { error: error.status ? error.message : '서버 요청 처리 실패' });
      else response.destroy();
    }
  });
  if (collector) collector.onFatal = () => { process.exitCode = 1; close(); };
  server.requestTimeout = 30000;
  function close() {
    collector?.stop(); channelManager?.stop();
    for (const sub of subscribers) sub.response.end();
    return new Promise(resolveClose => server.close(() => { store.close(); resolveClose(); }));
  }
  return { server, store, collector, channelManager, close,
    async listen(port = 3000, host = '0.0.0.0') {
      server.listen(port, host); await once(server, 'listening');
      if (collect) {
        if (channelManager) await channelManager.start(); else collector.start();
      }
      return server.address();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp({ filename: process.env.DATA_FILE || resolve(root, 'data/captions.sqlite'),
    liveListUrl: process.env.BROADCAST_LIST_URL || defaultListUrl,
    channelRefreshMs: Number(process.env.CHANNEL_REFRESH_MS || 30000) });
  const address = await app.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0');
  console.log(`방송 채널: ${app.channelManager.snapshot().channels.filter(channel => channel.onAir).map(channel => channel.name).join(', ') || 'ON AIR 없음'}`);
  console.log(`자막 서버 실행: http://0.0.0.0:${address.port} (자막 수집은 브라우저 접속과 무관하게 계속됩니다.)`);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (closing) return; closing = true;
    app.close().then(() => process.exit(process.exitCode || 0));
    setTimeout(() => process.exit(process.exitCode || 0), 5000).unref();
  });
}
