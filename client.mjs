import { initAudio } from './audio.mjs';

const $ = id => document.getElementById(id);
const channelStorageKey = 'assembly-caption-channel';
let config, audioController, stream, loadAbort, generation = 0, wantsLive = true, loading = false;
let cursor = 0, collectorState = 'connecting', followFrame = null, renderFrame = null;
let captions = new Map(), records = new Map(), channels = [], channelId = '', preferredChannelId = '', viewDay = '';
let chromeTimer = null;
const compactScreen = window.matchMedia?.('(max-width: 850px)');

function selectedChannel() { return channels.find(channel => channel.id === channelId) ?? null; }
function isPlayableChannel(channel) { return Boolean(channel?.onAir && channel.source && channel.audioUrl); }

function keepChromeVisible() {
  if (chromeTimer !== null) window.clearTimeout?.(chromeTimer);
  chromeTimer = null;
  document.body.classList.remove('chrome-hidden');
}

function canAutoHideChrome() {
  return Boolean(compactScreen?.matches && wantsLive && !loading && selectedChannel() && config &&
    $('date').value === config.today && collectorState === 'connected' && !$('source-settings').open);
}

function revealChrome() {
  keepChromeVisible();
  if (!canAutoHideChrome() || !window.setTimeout) return;
  chromeTimer = window.setTimeout(() => {
    chromeTimer = null;
    if (canAutoHideChrome()) document.body.classList.add('chrome-hidden');
  }, 3500);
}

function controlState(message) {
  const liveDate = !config || !$('date').value || $('date').value === config.today;
  const playable = isPlayableChannel(selectedChannel());
  const active = wantsLive && liveDate && playable;
  $('connect').checked = active;
  $('connect').disabled = !playable || !liveDate;
  if (message) $('status').textContent = message;
}

function updateStatus() {
  const channel = selectedChannel();
  if (!channel) { controlState(channels.length ? '채널 정보를 선택해 주세요.' : '오늘 중계 예정인 위원회가 없습니다.'); return; }
  if (loading) { controlState('저장된 자막 불러오는 중'); return; }
  if (config && $('date').value !== config.today) { controlState(`${$('date').value} 저장 기록 보기`); return; }
  if (!isPlayableChannel(channel)) {
    controlState(`${channel.name} · ${channel.statusText || (channel.onAir ? '재생 주소 확인 중' : '현재 방송 중이 아님')} · 저장 기록 보기`); return;
  }
  if (!wantsLive) { controlState('화면 수신 일시정지 · 서버 수집은 계속됩니다.'); return; }
  const label = { connected: '서버 수집 중', connecting: '수집 서버 연결 중',
    reconnecting: '수집 서버 재연결 중', stopped: '수집 서버 중지' }[collectorState] || '서버 상태 확인 중';
  controlState(`실시간 수신 중 · ${label}`);
}

function syncLayout() {
  const toolbar = document.querySelector('.controls');
  const header = document.querySelector('.top-panel');
  document.documentElement.style.setProperty('--toolbar-height', `${Math.ceil(toolbar.getBoundingClientRect().height)}px`);
  document.documentElement.style.setProperty('--header-height', `${Math.ceil(header.getBoundingClientRect().height)}px`);
  followLatest();
}

function followLatest() {
  if (followFrame !== null) return;
  followFrame = requestAnimationFrame(() => {
    followFrame = null;
    if (!$('follow').checked || $('search').value.trim()) return;
    const latest = $('rows').querySelector('article:last-of-type');
    if (!latest) return;
    const scroller = $('caption-scroller');
    const bottom = scroller.getBoundingClientRect().bottom - 12;
    scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + latest.getBoundingClientRect().bottom - bottom), behavior: 'auto' });
  });
}

function cleanRows(mode = $('mode').value) {
  const rows = [...captions.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return mode === 'final' ? rows.filter(row => row.final !== false) : rows;
}

function visibleRows() {
  if ($('mode').value !== 'raw') return cleanRows();
  return [...records.values()].filter(row => row.text.trim()).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function render() {
  const query = $('search').value.trim().toLowerCase();
  const rows = visibleRows().filter(row => !query || row.text.toLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const article = document.createElement('article'); article.textContent = row.text; fragment.append(article);
  }
  if (!rows.length) {
    const paragraph = document.createElement('p'); paragraph.className = 'note'; paragraph.style.padding = '20px';
    paragraph.textContent = loading ? '저장된 자막을 불러오고 있습니다.' : query ? '검색 결과가 없습니다.' :
      !selectedChannel() ? '오늘 표시할 위원회가 없습니다.' :
      $('mode').value === 'final' ? '완성된 자막이 아직 없습니다.' : '이 채널에 저장된 자막이 아직 없습니다.';
    fragment.append(paragraph);
  }
  $('rows').replaceChildren(fragment);
  const channel = selectedChannel();
  const day = viewDay || $('date').value;
  $('count').textContent = channel ? `${day} · ${channel.name} · ${cleanRows('clean').length}개 자막${query ? ` · 검색 ${rows.length}개` : ''}` : 'ON AIR 채널 없음';
  followLatest();
}

function scheduleRender() {
  if (renderFrame !== null) return;
  renderFrame = requestAnimationFrame(() => { renderFrame = null; render(); });
}

function applyCaption(row) {
  if (!row || (viewDay && row.day !== viewDay)) return;
  const old = captions.get(row.id);
  if (!old || old.revision <= row.revision) captions.set(row.id, row);
}

function applyRecord(row) {
  if (!row || (viewDay && row.day !== viewDay)) return;
  records.set(row.id, row);
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw Error(`서버 요청 실패 (${response.status})`);
  return response.json();
}

function openStream(token) {
  if (!wantsLive || token !== generation || !channelId || !isPlayableChannel(selectedChannel()) || $('date').value !== config.today) return;
  const current = new EventSource(`/api/events?channel=${encodeURIComponent(channelId)}&date=${encodeURIComponent($('date').value)}&since=${cursor}`);
  stream = current;
  current.onopen = updateStatus;
  current.onerror = () => {
    if (stream === current && wantsLive) controlState('화면 연결 복구 중 · 서버 기록은 계속 저장됩니다.');
  };
  current.addEventListener('caption', event => {
    if (stream !== current || token !== generation) return;
    const item = JSON.parse(event.data); cursor = Math.max(cursor, item.cursor);
    applyCaption(item.caption); if ($('mode').value === 'raw') applyRecord(item.record); scheduleRender();
  });
  current.addEventListener('status', event => {
    if (stream !== current) return;
    const previous = collectorState;
    collectorState = JSON.parse(event.data).state; updateStatus();
    if (collectorState !== 'connected') keepChromeVisible();
    else if (previous !== 'connected') revealChrome();
  });
  current.addEventListener('reset', () => { if (stream === current) loadView(); });
}

async function loadView() {
  keepChromeVisible();
  const token = ++generation;
  stream?.close(); stream = null; loadAbort?.abort(); loadAbort = new AbortController();
  captions = new Map(); records = new Map(); cursor = 0;
  if (!channelId) { loading = false; updateStatus(); render(); return; }
  loading = true; updateStatus(); render();
  try {
    const mode = $('mode').value === 'raw' ? 'raw' : 'clean';
    let after = 0, first = true;
    while (true) {
      const page = await getJson(`/api/captions?channel=${encodeURIComponent(channelId)}&date=${encodeURIComponent($('date').value)}&mode=${mode}&after=${after}&limit=1000`, { signal: loadAbort.signal });
      if (token !== generation) return;
      if (first) { cursor = page.cursor; viewDay = page.day; first = false; }
      for (const row of page.rows) mode === 'raw' ? applyRecord(row) : applyCaption(row);
      scheduleRender();
      if (!page.hasMore) break;
      after = page.next;
    }
    loading = false; updateStatus(); render(); openStream(token); revealChrome();
  } catch (error) {
    if (token !== generation || error.name === 'AbortError') return;
    loading = false; controlState('채널 자막을 불러오지 못했습니다.'); render();
  }
}

function renderChannelOptions() {
  const fragment = document.createDocumentFragment();
  for (const channel of channels) {
    const option = document.createElement('option'); option.value = channel.id;
    const state = channel.onAir ? '● ON AIR' : `○ ${channel.statusText || '종료'}`;
    option.textContent = `${state} · ${channel.name}${channel.subject ? ` · ${channel.subject}` : ''}`;
    fragment.append(option);
  }
  $('channel').replaceChildren(fragment); $('channel').value = channelId;
  $('channel').disabled = channels.length === 0;
}

function activateChannel(id) {
  keepChromeVisible();
  channelId = id;
  if (id) {
    preferredChannelId = id;
    try { window.localStorage?.setItem(channelStorageKey, id); } catch {}
  }
  const channel = selectedChannel();
  $('channel').value = id;
  $('source-url').value = channel?.source || '';
  $('audio-url').value = isPlayableChannel(channel) ? channel.audioUrl : '';
  audioController?.setSource(isPlayableChannel(channel) ? channel.audioUrl : '');
  collectorState = channel?.collector?.state || 'connecting';
  loadView();
}

async function refreshChannels(manual = false) {
  if (manual) $('refresh-channels').disabled = true;
  try {
    const data = await getJson(manual ? '/api/channels?refresh=1' : '/api/channels');
    const previousPlayable = isPlayableChannel(selectedChannel());
    channels = [...data.channels].sort((left, right) =>
      Number(left.statusText?.trim() === '생중계 없음') - Number(right.statusText?.trim() === '생중계 없음'));
    const playable = channels.filter(isPlayableChannel);
    const wantedId = channelId || preferredChannelId;
    const nextId = channels.find(channel => channel.id === wantedId)?.id || playable[0]?.id || channels[0]?.id || '';
    renderChannelOptions();
    const changed = nextId !== channelId;
    if (changed || !selectedChannel()) activateChannel(nextId);
    else {
      const channel = selectedChannel();
      $('channel').value = channelId;
      $('source-url').value = channel.source || '';
      const nextAudio = isPlayableChannel(channel) ? channel.audioUrl : '';
      if ($('audio-url').value !== nextAudio) audioController?.setSource(nextAudio);
      collectorState = channel.collector?.state || collectorState; updateStatus();
      let reload = previousPlayable !== isPlayableChannel(channel);
      if (data.today && data.today !== config.today) {
        const followedToday = !$('date').value || $('date').value === config.today;
        config.today = data.today; $('date').max = data.today;
        if (followedToday) { $('date').value = data.today; reload = true; }
      }
      if (reload) loadView();
    }
    const refreshed = data.refreshedAt ? new Date(data.refreshedAt).toLocaleTimeString('ko-KR') : '방금';
    const onAirCount = channels.filter(channel => channel.onAir).length;
    const scheduledCount = channels.filter(channel => channel.statusText?.trim() !== '생중계 없음').length;
    $('channel-refresh-status').textContent = data.lastError ? `목록 갱신 실패 · ${data.lastError}` :
      onAirCount ? `채널 목록 ${refreshed} 갱신 · ON AIR ${onAirCount}개` : `현재 ON AIR 없음 · 오늘 편성 채널 ${scheduledCount}개 · ${refreshed} 갱신`;
  } catch {
    $('channel-refresh-status').textContent = '채널 목록 갱신 실패 · 다시 시도하세요.';
  } finally { if (manual) $('refresh-channels').disabled = false; }
}

async function start() {
  try {
    config = await getJson('/api/config');
    $('date').value = config.today; $('date').max = config.today;
    try { preferredChannelId = window.localStorage?.getItem(channelStorageKey) || ''; } catch {}
    audioController = initAudio($);
    await refreshChannels();
    window.setInterval?.(() => refreshChannels(), Math.max(10000, config.channelRefreshMs || 30000));
  } catch {
    wantsLive = false; controlState('서버 주소로 접속해 주세요. 연결하려면 자막 재생 스위치를 켜세요.');
  }
}

$('connect').onchange = () => {
  if (!$('connect').checked) { wantsLive = false; stream?.close(); stream = null; updateStatus(); keepChromeVisible(); }
  else { wantsLive = true; channelId ? loadView() : refreshChannels(true); }
};
$('channel').onchange = () => activateChannel($('channel').value);
$('refresh-channels').onclick = () => refreshChannels(true);
$('date').onchange = () => {
  if (!$('date').value) $('date').value = config.today;
  loadView();
};
let previousMode = $('mode').value;
$('mode').onchange = () => {
  const rawChanged = previousMode === 'raw' || $('mode').value === 'raw'; previousMode = $('mode').value;
  if (rawChanged) loadView(); else render();
};
$('search').oninput = scheduleRender;
$('follow').onchange = followLatest;
$('txt').onclick = () => {
  if (!channelId) return;
  const link = document.createElement('a');
  link.href = `/api/export?channel=${encodeURIComponent(channelId)}&date=${encodeURIComponent($('date').value)}&mode=${$('mode').value}`;
  link.download = `captions-${channelId}-${$('date').value}.txt`; link.click();
};

let wakeSentinel = null, wakePending = false;
async function keepScreen() {
  if (!$('keep-screen').checked) {
    await wakeSentinel?.release(); wakeSentinel = null; $('screen-status').textContent = '화면 유지 꺼짐'; return;
  }
  if (!window.isSecureContext) { $('screen-status').textContent = '화면 유지: HTTPS 접속 필요'; return; }
  if (!('wakeLock' in navigator)) { $('screen-status').textContent = '이 브라우저는 화면 유지 미지원'; return; }
  if (document.visibilityState !== 'visible' || wakeSentinel || wakePending) return;
  wakePending = true;
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    if (!$('keep-screen').checked) { await sentinel.release(); return; }
    wakeSentinel = sentinel; $('screen-status').textContent = '화면 켜두기 활성';
    sentinel.addEventListener('release', () => {
      if (wakeSentinel === sentinel) wakeSentinel = null;
      $('screen-status').textContent = $('keep-screen').checked ? '화면 유지 해제됨' : '화면 유지 꺼짐';
    });
  } catch { $('screen-status').textContent = '화면 유지 불가 · 절전 설정 확인'; }
  finally { wakePending = false; }
}
$('keep-screen').onchange = keepScreen;
for (const eventName of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'wheel', 'keydown']) {
  document.addEventListener(eventName, revealChrome, { passive: true });
}
$('source-settings').addEventListener('toggle', () => $('source-settings').open ? keepChromeVisible() : revealChrome());
compactScreen?.addEventListener?.('change', revealChrome);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { keepScreen(); revealChrome(); } });
window.addEventListener('pagehide', () => { keepChromeVisible(); wakeSentinel?.release().catch(() => {}); stream?.close(); });
window.addEventListener('pageshow', event => { if (event.persisted) { if (wantsLive) loadView(); keepScreen(); revealChrome(); } });
window.addEventListener('resize', syncLayout, { passive: true });
window.visualViewport?.addEventListener('resize', syncLayout, { passive: true });
if (typeof ResizeObserver !== 'undefined') {
  const layoutObserver = new ResizeObserver(syncLayout);
  layoutObserver.observe(document.querySelector('.controls'));
  layoutObserver.observe(document.querySelector('.top-panel'));
}
syncLayout(); keepScreen(); start();
