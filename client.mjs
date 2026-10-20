import { initMedia, isLiveChannel, isPlayableChannel, canReceiveCaptions } from './media.mjs';
import { parseCaption, segmentKey, seoulSlot } from './lib/caption-format.mjs';

const $ = id => document.getElementById(id);
const channelStorageKey = 'assembly-caption-channel';
let config, mediaController, stream, loadAbort, reconnectTimer = null, generation = 0, wantsLive = true, loading = false, bufferingLive = false;
let collectorState = 'connecting', followFrame = null, renderFrame = null, layoutFrame = null;
let captions = new Map(), records = new Map(), segmentIds = new Map(), lastServerId = 0, nextLiveId = 1, nextRecordId = 1;
let articles = new Map(), rawArticles = new Map(), dirtyStructure = true;
let orderedCaptions = null, finalCaptions = null, orderedRecords = null, renderedRows = null, renderedCount = 0, renderedSlot = null, latestArticle = null;
const pendingCaptionUpdates = new Set(), pendingRecordUpdates = new Set(), layoutHeights = new Map();
let channels = [], channelId = '', preferredChannelId = '', viewDay = '';
let channelOptionsKey = '', refreshingChannels = null, refreshDeferred = false;
let chromeTimer = null;
let keyboardNavigation = false;

function selectedChannel() { return channels.find(channel => channel.id === channelId) ?? null; }

function keepChromeVisible() {
  if (chromeTimer !== null) window.clearTimeout?.(chromeTimer);
  chromeTimer = null;
  document.body.classList.remove('chrome-hidden');
}

function canAutoHideChrome() {
  return Boolean(wantsLive && !loading && selectedChannel() && config &&
    $('date').value === config.today && collectorState === 'connected' && !$('source-settings').open &&
    $('search-panel').hidden && !(keyboardNavigation &&
      ['channel', 'date', 'mode'].some(id => $(id) === document.activeElement)));
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
  const playable = canReceiveCaptions(selectedChannel());
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
  if (!canReceiveCaptions(channel)) {
    controlState(`${channel.name} · ${channel.statusText || (channel.onAir ? '재생 주소 확인 중' : '현재 방송 중이 아님')} · 저장 기록 보기`); return;
  }
  if (!wantsLive) { controlState('화면 수신 일시정지 · 서버 수집은 계속됩니다.'); return; }
  const label = { connected: '서버 수집 중', connecting: '수집 서버 연결 중',
    reconnecting: '수집 서버 재연결 중', stopped: '수집 서버 중지' }[collectorState] || '서버 상태 확인 중';
  controlState(`실시간 수신 중 · ${label}`);
}

function syncLayout() {
  if (layoutFrame !== null) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = null;
    const panel = $('media-panel');
    const heights = [
      ['--toolbar-height', Math.ceil(document.querySelector('.controls').getBoundingClientRect().height)],
      ['--header-height', Math.ceil(document.querySelector('.top-panel').getBoundingClientRect().height)],
      ['--video-height', panel.hidden ? 0 : Math.ceil(panel.getBoundingClientRect().height)],
    ];
    for (const [name, height] of heights) if (layoutHeights.get(name) !== height) {
      layoutHeights.set(name, height);
      document.documentElement.style.setProperty(name, `${height}px`);
    }
    followLatest();
  });
}

function followLatest() {
  if (followFrame !== null) return;
  followFrame = requestAnimationFrame(() => {
    followFrame = null;
    if (!$('follow').checked || $('search').value.trim()) return;
    const latest = latestArticle;
    if (!latest) return;
    const scroller = $('caption-scroller');
    const bottom = scroller.getBoundingClientRect().bottom - 12;
    const top = Math.max(0, scroller.scrollTop + latest.getBoundingClientRect().bottom - bottom);
    if (Math.abs(top - scroller.scrollTop) >= 1) scroller.scrollTo({ top, behavior: 'auto' });
  });
}

function cleanRows(mode = $('mode').value) {
  orderedCaptions ??= [...captions.values()].sort((a, b) => a._time - b._time);
  if (mode !== 'final') return orderedCaptions;
  return finalCaptions ??= orderedCaptions.filter(row => row.final !== false);
}

function visibleRows() {
  if ($('mode').value !== 'raw') return cleanRows();
  return orderedRecords ??= [...records.values()].filter(row => row.text.trim()).sort((a, b) => a._time - b._time);
}

function render() {
  if (renderFrame !== null) { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(renderFrame); renderFrame = null; }
  const query = $('search').value.trim().toLowerCase();
  const sourceRows = visibleRows();
  const rows = query ? sourceRows.filter(row => (row._search ??= row.text.toLowerCase()).includes(query)) : sourceRows;
  const samePrefix = rows === renderedRows || (query && rows.length >= renderedCount &&
    rows.every((row, index) => index >= renderedCount || row === renderedRows?.[index]));
  const rebuild = dirtyStructure || !samePrefix || rows.length < renderedCount;
  for (const [pending, nodes, data] of [[pendingCaptionUpdates, articles, captions], [pendingRecordUpdates, rawArticles, records]]) {
    for (const id of pending) {
      const article = nodes.get(id), row = data.get(id);
      if (article && row && article.textContent !== row.text) article.textContent = row.text;
    }
    pending.clear();
  }
  const matchCount = query ? rows.length : captions.size;
  if (rebuild || rows.length > renderedCount) {
    const fragment = document.createDocumentFragment();
    let prevSlot = rebuild ? null : renderedSlot;
    if (rebuild) latestArticle = null;
    const nodes = $('mode').value === 'raw' ? rawArticles : articles;
    for (let index = rebuild ? 0 : renderedCount; index < rows.length; index++) {
      const row = rows[index];
      const slot = query ? null : (row._slot ??= seoulSlot(row.at));
      if (slot && prevSlot && slot !== prevSlot) {
        const divider = document.createElement('p');
        divider.className = 'time-divider';
        divider.textContent = `─── ${slot} ───`;
        fragment.append(divider);
      }
      if (slot) prevSlot = slot;
      let article = nodes.get(row.id);
      if (!article) {
        article = document.createElement('article');
        nodes.set(row.id, article);
      }
      if (article.textContent !== row.text) article.textContent = row.text;
      fragment.append(article);
      latestArticle = article;
    }
    if (!rows.length) {
      const paragraph = document.createElement('p'); paragraph.className = 'note'; paragraph.style.padding = '20px';
      paragraph.textContent = loading ? '저장된 자막을 불러오고 있습니다.' : query ? '검색 결과가 없습니다.' :
        !selectedChannel() ? '오늘 표시할 위원회가 없습니다.' :
        $('mode').value === 'final' ? '완성된 자막이 아직 없습니다.' : '이 채널에 저장된 자막이 아직 없습니다.';
      fragment.append(paragraph);
    }
    if (rebuild || renderedCount === 0) $('rows').replaceChildren(fragment);
    else $('rows').append(fragment);
    renderedRows = rows; renderedCount = rows.length; renderedSlot = prevSlot;
    dirtyStructure = !rows.length;
  }
  const channel = selectedChannel();
  const day = viewDay || $('date').value;
  const count = channel ? `${day} · ${channel.name} · ${captions.size}개 자막${query ? ` · 검색 ${matchCount}개` : ''}` : 'ON AIR 채널 없음';
  if ($('count').textContent !== count) $('count').textContent = count;
  mediaController?.setCaptions(sourceRows, {
    live: Boolean(config && $('date').value === config.today && day === config.today),
  });
  followLatest();
}

function scheduleRender() {
  if (renderFrame !== null) return;
  const frame = requestAnimationFrame(() => { if (renderFrame === frame) { renderFrame = null; render(); } });
  renderFrame = frame;
}

function applyCaption(row) {
  if (!row || (row.day && viewDay && row.day !== viewDay)) return;
  if (row.k && segmentIds.has(row.k)) {
    row.id = segmentIds.get(row.k);
  } else if (captions.has(row.id) && row.k && captions.get(row.id).k && captions.get(row.id).k !== row.k) {
    row.id = nextLiveId++;
  }
  if (row.id >= nextLiveId) nextLiveId = row.id + 1;
  if (row.k) segmentIds.set(row.k, row.id);
  const old = captions.get(row.id);
  if (!old || old.revision === undefined || row.revision === undefined || old.revision <= row.revision) {
    row._time = old?._time ?? Date.parse(row.at); row._search = row.text.toLowerCase();
    if (old) {
      const membershipChanged = (old.final !== false) !== (row.final !== false);
      Object.assign(old, row);
      if (membershipChanged) finalCaptions = old.final !== false ? appendOrdered(finalCaptions, old) : null;
    } else {
      captions.set(row.id, row);
      orderedCaptions = appendOrdered(orderedCaptions, row);
      if (row.final !== false) finalCaptions = appendOrdered(finalCaptions, row);
    }
    if (articles.has(row.id)) pendingCaptionUpdates.add(row.id);
  }
}

function appendOrdered(rows, row) {
  if (!rows || !Number.isFinite(row._time) || (rows.length && row._time < rows.at(-1)._time)) return null;
  rows.push(row); return rows;
}

function applyRecord(row) {
  if (!row || (row.day && viewDay && row.day !== viewDay)) return;
  if (row.id >= nextRecordId) nextRecordId = row.id + 1;
  const old = records.get(row.id);
  if (!old && !row.text.trim()) return;
  row._time = Date.parse(row.at); row._search = row.text.toLowerCase(); row._slot = seoulSlot(row.at);
  if (old) {
    const membershipChanged = Boolean(old.text.trim()) !== Boolean(row.text.trim());
    const timeChanged = old._time !== row._time;
    Object.assign(old, row);
    if (membershipChanged || timeChanged) orderedRecords = null;
  } else {
    records.set(row.id, row);
    if (row.text.trim()) orderedRecords = appendOrdered(orderedRecords, row);
  }
  if (rawArticles.has(row.id)) pendingRecordUpdates.add(row.id);
}

function handleLiveMessage(raw, fromBuffer = false) {
  const text = String(raw ?? '');
  if ($('mode').value === 'raw') {
    let rawItem = null;
    try { rawItem = JSON.parse(text); } catch {}
    if (rawItem && typeof rawItem === 'object' && ('record' in rawItem || 'id' in rawItem)) {
      const rec = rawItem.record ?? rawItem;
      applyRecord({ id: rec.id ?? nextRecordId++, at: rec.at ?? new Date().toISOString(), text: rec.text ?? '' });
      if (!('segment' in rawItem) && !('caption' in rawItem)) return;
    }
  }
  const parsed = parseCaption(text);
  if (!parsed) return;
  const k = segmentKey(parsed.offset, parsed.segment);
  let id = k ? segmentIds.get(k) : undefined;
  const existing = id !== undefined ? captions.get(id) : undefined;
  if (fromBuffer && existing && existing.final !== false && parsed.final === false) return;
  if (id === undefined) {
    id = nextLiveId++;
    if (k) segmentIds.set(k, id);
  }
  const at = existing?.at ?? parsed.at ?? new Date().toISOString();
  applyCaption({ id, k, text: parsed.text, final: parsed.final !== false, at });
  if ($('mode').value === 'raw') {
    applyRecord({ id: nextRecordId++, at: parsed.at ?? new Date().toISOString(), text: parsed.text });
  }
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw Error(`서버 요청 실패 (${response.status})`);
  return response.json();
}

function closeStream() {
  bufferingLive = false;
  if (reconnectTimer !== null) { window.clearTimeout?.(reconnectTimer); reconnectTimer = null; }
  if (!stream) return;
  const current = stream;
  stream = null;
  current.onopen = current.onmessage = current.onerror = current.onclose = null;
  current.close?.();
}

function openStream(token, buffered) {
  const channel = selectedChannel();
  if (!wantsLive || token !== generation || !channelId || !canReceiveCaptions(channel) || $('date').value !== config.today) return;
  bufferingLive = Boolean(buffered);
  const current = new WebSocket(channel.source, 'echo-protocol');
  stream = current;
  current.onopen = () => {
    if (stream !== current || token !== generation) return;
    collectorState = 'connected';
    updateStatus();
    if (!loading) revealChrome();
  };
  current.onmessage = event => {
    if (stream !== current || token !== generation) return;
    if (loading || bufferingLive) { buffered?.push(event.data); return; }
    handleLiveMessage(event.data, false);
    scheduleRender();
  };
  current.onerror = () => {
    if (stream === current && wantsLive) {
      collectorState = 'reconnecting';
      keepChromeVisible();
      controlState('화면 연결 복구 중 · 서버 기록은 계속 저장됩니다.');
    }
  };
  current.onclose = () => {
    if (stream !== current || token !== generation || !wantsLive) return;
    stream = null;
    bufferingLive = false;
    collectorState = 'reconnecting';
    keepChromeVisible();
    controlState('화면 연결 복구 중 · 서버 기록은 계속 저장됩니다.');
    if (window.setTimeout) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (wantsLive && token === generation) resumeView();
      }, 2000);
    }
  };
}

async function fetchCaptionsSince(after, mode, token, setViewDay = false) {
  let first = setViewDay;
  while (true) {
    const page = await getJson(`/api/captions?channel=${encodeURIComponent(channelId)}&date=${encodeURIComponent($('date').value)}&mode=${mode}&after=${after}&limit=1000`, { signal: loadAbort.signal });
    if (token !== generation) return false;
    if (first) { viewDay = page.day; first = false; }
    if (page.rows.length) lastServerId = Math.max(lastServerId, page.rows.at(-1).id);
    for (const row of page.rows) mode === 'raw' ? applyRecord(row) : applyCaption(row);
    if (!page.hasMore) return true;
    after = page.next;
  }
}

async function resumeView() {
  if (!channelId || loading || !viewDay || viewDay !== $('date').value) return loadView();
  const token = ++generation;
  closeStream(); loadAbort?.abort(); loadAbort = new AbortController();
  const buffered = [];
  openStream(token, buffered);
  updateStatus();
  try {
    const mode = $('mode').value === 'raw' ? 'raw' : 'clean';
    const completed = await fetchCaptionsSince(lastServerId, mode, token, false);
    if (!completed) return;
    bufferingLive = false;
    for (const raw of buffered) handleLiveMessage(raw, true);
    buffered.length = 0;
    updateStatus(); render(); revealChrome();
  } catch (error) {
    if (token !== generation || error.name === 'AbortError') return;
    bufferingLive = false;
    for (const raw of buffered) handleLiveMessage(raw, true);
    buffered.length = 0;
    updateStatus(); render();
  }
}

async function loadView() {
  keepChromeVisible();
  const token = ++generation;
  closeStream(); loadAbort?.abort(); loadAbort = new AbortController();
  captions = new Map(); records = new Map(); segmentIds = new Map(); lastServerId = 0; nextLiveId = 1; nextRecordId = 1;
  articles = new Map(); rawArticles = new Map(); dirtyStructure = true;
  orderedCaptions = finalCaptions = orderedRecords = renderedRows = null; renderedCount = 0; renderedSlot = null; latestArticle = null;
  pendingCaptionUpdates.clear(); pendingRecordUpdates.clear();
  if (!channelId) { loading = false; updateStatus(); render(); return; }
  loading = true; updateStatus(); render();
  const buffered = [];
  openStream(token, buffered);
  try {
    const mode = $('mode').value === 'raw' ? 'raw' : 'clean';
    const completed = await fetchCaptionsSince(0, mode, token, true);
    if (!completed) return;
    bufferingLive = false;
    for (const raw of buffered) handleLiveMessage(raw, true);
    buffered.length = 0;
    loading = false; updateStatus(); render(); revealChrome();
  } catch (error) {
    if (token !== generation || error.name === 'AbortError') return;
    closeStream();
    loading = false; controlState('채널 자막을 불러오지 못했습니다.'); render();
  }
}

function channelBullet(channel) {
  if (isLiveChannel(channel)) return '⬤';
  const state = (channel.statusText || '').replace(/\s/g, '');
  if (state.includes('계속예정')) return '▷';
  if (state.includes('예정')) return '◷';
  if (/중지|정회/.test(state)) return 'Ⅱ';
  if (/종료|산회|폐회/.test(state)) return '✓';
  return '○';
}

function renderChannelOptions() {
  const options = channels.map(channel => {
    const state = isLiveChannel(channel) ? 'ON AIR' : channel.statusText || '종료';
    return [channel.id, `${channelBullet(channel)} ${channel.name} · ${state}${channel.subject ? ` · ${channel.subject}` : ''}`];
  });
  const key = JSON.stringify(options);
  if (key !== channelOptionsKey) {
    const fragment = document.createDocumentFragment();
    for (const [id, label] of options) {
      const option = document.createElement('option'); option.value = id; option.textContent = label;
      fragment.append(option);
    }
    $('channel').replaceChildren(fragment); channelOptionsKey = key;
  }
  $('channel').value = channelId;
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
  mediaController?.setSource(channel);
  collectorState = channel?.collector?.state || 'connecting';
  loadView();
}

async function refreshChannels(manual = false) {
  if (!manual && refreshingChannels) return refreshingChannels;
  if (manual) $('refresh-channels').disabled = true;
  const task = (async () => {
    try {
      const data = await getJson(manual ? '/api/channels?refresh=1' : '/api/channels');
      const wasOnAir = isLiveChannel(selectedChannel());
      const previousCaptionReady = canReceiveCaptions(selectedChannel());
      channels = [...data.channels].sort((left, right) =>
        Number(left.statusText?.trim() === '생중계 없음') - Number(right.statusText?.trim() === '생중계 없음'));
      const playable = channels.filter(isLiveChannel);
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
        $('audio-url').value = nextAudio;
        mediaController?.setSource(channel);
        collectorState = channel.collector?.state || collectorState; updateStatus();
        let reload = previousCaptionReady !== canReceiveCaptions(channel);
        if (data.today && data.today !== config.today) {
          const followedToday = !$('date').value || $('date').value === config.today;
          config.today = data.today; $('date').max = data.today;
          if (followedToday) { $('date').value = data.today; reload = true; }
        }
        if (!wasOnAir && isLiveChannel(channel) && $('date').value === config.today) {
          wantsLive = true; reload = true;
        }
        if (reload) {
          if (wantsLive && viewDay === $('date').value) resumeView();
          else loadView();
        }
      }
      const refreshed = data.refreshedAt ? new Date(data.refreshedAt).toLocaleTimeString('ko-KR') : '방금';
      const onAirCount = playable.length;
      const scheduledCount = channels.filter(channel => channel.statusText?.trim() !== '생중계 없음').length;
      $('channel-refresh-status').textContent = data.lastError ? `목록 갱신 실패 · ${data.lastError}` :
        onAirCount ? `채널 목록 ${refreshed} 갱신 · ON AIR ${onAirCount}개` : `현재 ON AIR 없음 · 오늘 편성 채널 ${scheduledCount}개 · ${refreshed} 갱신`;
    } catch {
      $('channel-refresh-status').textContent = '채널 목록 갱신 실패 · 다시 시도하세요.';
    } finally {
      if (refreshingChannels === task) refreshingChannels = null;
      if (manual) $('refresh-channels').disabled = false;
    }
  })();
  refreshingChannels = task;
  return task;
}

async function start() {
  try {
    config = await getJson('/api/config');
    $('date').value = config.today; $('date').max = config.today;
    try { preferredChannelId = window.localStorage?.getItem(channelStorageKey) || ''; } catch {}
    mediaController = initMedia($, { onLayout: syncLayout });
    await refreshChannels();
    window.setInterval?.(() => {
      if (document.visibilityState === 'hidden') { refreshDeferred = true; return; }
      refreshChannels();
    }, Math.max(10000, config.channelRefreshMs || 30000));
  } catch {
    wantsLive = false; controlState('서버 주소로 접속해 주세요. 연결하려면 자막 재생 스위치를 켜세요.');
  }
}

$('connect').onchange = () => {
  if (!$('connect').checked) { wantsLive = false; closeStream(); updateStatus(); keepChromeVisible(); }
  else { wantsLive = true; channelId ? resumeView() : refreshChannels(true); }
};
$('channel').onchange = () => activateChannel($('channel').value);
$('refresh-channels').onclick = () => refreshChannels(true);
function closeSearch() {
  $('search-panel').hidden = true;
  $('search-toggle').setAttribute('aria-expanded', 'false');
  $('search').value = ''; dirtyStructure = true; scheduleRender();
  $('search-toggle').focus(); syncLayout(); revealChrome();
}
$('search-toggle').onclick = () => {
  if (!$('search-panel').hidden) { closeSearch(); return; }
  $('search-panel').hidden = false;
  $('search-toggle').setAttribute('aria-expanded', 'true');
  keepChromeVisible(); syncLayout(); $('search').focus();
};
$('search-close').onclick = closeSearch;
$('search').onkeydown = event => {
  if (event.key === 'Escape') { event.preventDefault(); closeSearch(); }
};
for (const id of ['channel', 'date', 'mode']) {
  $(id).addEventListener('focus', revealChrome);
  $(id).addEventListener('blur', revealChrome);
}
$('date').onchange = () => {
  if (!$('date').value) $('date').value = config.today;
  loadView();
};
let previousMode = $('mode').value;
$('mode').onchange = () => {
  const rawChanged = previousMode === 'raw' || $('mode').value === 'raw'; previousMode = $('mode').value;
  dirtyStructure = true;
  if (rawChanged) loadView(); else render();
};
$('search').oninput = () => { dirtyStructure = true; scheduleRender(); };
$('follow').onchange = followLatest;
function exportCaptions() {
  if (!channelId) return;
  const link = document.createElement('a');
  link.href = `/api/export?channel=${encodeURIComponent(channelId)}&date=${encodeURIComponent($('date').value)}&mode=${$('mode').value}`;
  link.download = `captions-${channelId}-${$('date').value}.txt`; link.click();
}
$('txt').onclick = exportCaptions;

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
let lastChromeReveal = 0;
for (const eventName of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'wheel', 'keydown']) {
  document.addEventListener(eventName, () => {
    if (eventName === 'keydown') keyboardNavigation = true;
    else if (eventName === 'pointerdown' || eventName === 'touchstart') keyboardNavigation = false;
    if (eventName === 'pointermove' || eventName === 'touchmove' || eventName === 'wheel') {
      const now = Date.now();
      if (!document.body.classList.contains('chrome-hidden') && now - lastChromeReveal < 200) return;
      lastChromeReveal = now;
    }
    revealChrome();
  }, { passive: true });
}
$('source-settings').addEventListener('toggle', () => $('source-settings').open ? keepChromeVisible() : revealChrome());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (refreshDeferred) { refreshDeferred = false; refreshChannels(); }
    keepScreen(); revealChrome();
  }
});
window.addEventListener('pagehide', () => { keepChromeVisible(); wakeSentinel?.release().catch(() => {}); closeStream(); });
window.addEventListener('pageshow', event => { if (event.persisted) { if (wantsLive) resumeView(); keepScreen(); revealChrome(); } });
window.addEventListener('resize', syncLayout, { passive: true });
window.visualViewport?.addEventListener('resize', syncLayout, { passive: true });
if (typeof ResizeObserver !== 'undefined') {
  const layoutObserver = new ResizeObserver(syncLayout);
  layoutObserver.observe(document.querySelector('.controls'));
  layoutObserver.observe(document.querySelector('.top-panel'));
  layoutObserver.observe($('media-panel'));
}
syncLayout(); keepScreen(); start();
