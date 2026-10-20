import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
  ['/media.mjs', ['media.mjs', 'text/javascript; charset=utf-8']],
  ['/adaptive-video.mjs', ['adaptive-video.mjs', 'text/javascript; charset=utf-8']],
  ['/hls-variants.mjs', ['hls-variants.mjs', 'text/javascript; charset=utf-8']],
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
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function formatEvent(name, value, cursor) {
  return `${cursor === undefined ? '' : `id: ${cursor}\n`}event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
}

function writeEvent(response, payload) {
  if (response.destroyed || response.writableEnded) return false;
  if (response.writableLength > 1024 * 1024) { response.destroy(); return false; }
  response.write(payload);
  return true;
}

function event(response, name, value, cursor) {
  return writeEvent(response, formatEvent(name, value, cursor));
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
  channelRefreshMs = 30000, manualRefreshCooldownMs = 5000,
  fetchImpl, collect = true, WebSocketClass,
  gaMeasurementId = '', gaHostname = 'soju.day' } = {}) {
  gaMeasurementId = gaMeasurementId.trim();
  gaHostname = gaHostname.trim().toLowerCase();
  if (gaMeasurementId && !/^G-[A-Z0-9]+$/.test(gaMeasurementId)) {
    throw Error('GA_MEASUREMENT_ID는 G-로 시작하는 영문 대문자·숫자 측정 ID여야 합니다.');
  }
  if (gaMeasurementId && !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(gaHostname)) {
    throw Error('GA_HOSTNAME에는 프로토콜이나 경로 없이 도메인을 입력하세요.');
  }
  const analyticsTag = gaMeasurementId ? `
<!-- Google tag (gtag.js) -->
<script>
if (location.hostname === ${JSON.stringify(gaHostname)}) {
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  gtag('js', new Date());
  gtag('config', '${gaMeasurementId}');
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtag/js?id=${gaMeasurementId}';
  document.head.appendChild(script);
}
</script>` : '';
  const assetCache = new Map();
  async function getAsset(assetName, contentType) {
    let cached = assetCache.get(assetName);
    if (!cached) {
      let content = await readFile(resolve(root, assetName));
      if (assetName === 'captions.html' && analyticsTag) {
        content = Buffer.from(content.toString('utf8').replace('<head>', `<head>${analyticsTag}`));
      }
      const etag = `W/"${createHash('sha256').update(content).digest('base64url').slice(0, 27)}"`;
      cached = { content, contentType, etag };
      assetCache.set(assetName, cached);
    }
    return cached;
  }
  const store = new CaptionStore(filename);
  const subscribers = new Set();
  let heartbeat = null;
  let lastManualRefresh = 0;
  function ensureHeartbeat() {
    if (heartbeat || !subscribers.size) return;
    heartbeat = setInterval(() => {
      for (const sub of subscribers) {
        if (!sub.response.destroyed && !sub.response.writableEnded) sub.response.write(': keepalive\n\n');
      }
    }, 15000);
    heartbeat.unref?.();
  }
  const sendCaption = (channelId, item) => {
    if (!item.caption && !item.record?.text?.trim()) return;
    let payload = null;
    for (const sub of subscribers) {
      if (sub.channelId === channelId && sub.day === item.day) {
        writeEvent(sub.response, payload ??= formatEvent('caption', item, item.cursor));
      }
    }
  };
  const sendStatus = (channelId, value) => {
    let payload = null;
    for (const sub of subscribers) {
      if (sub.channelId === channelId) writeEvent(sub.response, payload ??= formatEvent('status', { state: value.state }));
    }
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
        const [assetName, contentType] = assets.get(url.pathname);
        const cached = await getAsset(assetName, contentType);
        const headers = {
          'Content-Type': cached.contentType,
          'Cache-Control': 'no-cache',
          'ETag': cached.etag,
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'X-Frame-Options': 'DENY',
          'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
        };
        if (request.headers['if-none-match'] === cached.etag) {
          response.writeHead(304, headers);
          response.end(); return;
        }
        response.writeHead(200, headers);
        response.end(request.method === 'HEAD' ? undefined : cached.content); return;
      }
      if (url.pathname === '/api/config') {
        json(response, 200, { source: channelManager ? null : source, audioUrl: channelManager ? null : audioUrl,
          pageUrl: channelManager ? null : pageUrl, broadcast: channelManager ? null : broadcast,
          liveListUrl, channelRefreshMs, today: seoulDay(), timezone: 'Asia/Seoul' }); return;
      }
      if (url.pathname === '/api/channels') {
        if (channelManager && url.searchParams.get('refresh') === '1') {
          const now = Date.now();
          if (now - lastManualRefresh >= manualRefreshCooldownMs) {
            lastManualRefresh = now;
            await channelManager.refresh();
          }
        }
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
        const currentCursor = store.cursor(), since = integer(request.headers['last-event-id'] ?? url.searchParams.get('since'), currentCursor);
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        if (request.method === 'HEAD') { response.end(); return; }
        response.flushHeaders();
        const sub = { response, day, channelId: channel.id, source: channel.source };
        subscribers.add(sub);
        ensureHeartbeat();
        // No asynchronous gap between replaying missed records and subscribing to new ones.
        const backlog = store.eventsAfter(since, day, channel.source, 5001,
          channelManager ? channel.id : null, channel.historySources);
        if (backlog.length > 5000 || since > currentCursor) {
          event(response, 'reset', { reason: '서버 기록을 다시 불러옵니다.' });
        } else {
          for (const item of backlog) {
            if (!item.caption && !item.record?.text?.trim()) continue;
            if (!event(response, 'caption', item, item.cursor)) break;
          }
        }
        event(response, 'status', { state: channelManager?.collectors.get(channel.id)?.state.state ?? collector?.state.state ?? 'stopped' });
        response.on('close', () => {
          subscribers.delete(sub);
          if (!subscribers.size && heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        });
        return;
      }
      if (url.pathname === '/api/export') {
        const channel = selectedChannel(url, false), day = dayParam(url), mode = modeParam(url);
        if ((url.searchParams.get('format') || 'txt') !== 'txt') {
          json(response, 400, { error: 'TXT 저장만 지원합니다.' }); return;
        }
        const safeId = String(channel.id).replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="captions-${safeId}-${day}.txt"`, 'Cache-Control': 'no-store' });
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
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
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
    channelRefreshMs: Number(process.env.CHANNEL_REFRESH_MS || 30000),
    gaMeasurementId: process.env.GA_MEASUREMENT_ID || '',
    gaHostname: process.env.GA_HOSTNAME || 'soju.day' });
  const address = await app.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0');
  console.log(`방송 채널: ${app.channelManager.snapshot().channels.filter(channel => channel.onAir).map(channel => channel.name).join(', ') || 'ON AIR 없음'}`);
  const listenHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  console.log(`자막 서버 실행: http://${listenHost}:${address.port} (자막 수집은 브라우저 접속과 무관하게 계속됩니다.)`);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (closing) return; closing = true;
    app.close().then(() => process.exit(process.exitCode || 0));
    setTimeout(() => process.exit(process.exitCode || 0), 5000).unref();
  });
}
