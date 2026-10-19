const allowedHost = 'assembly.webcast.go.kr';
const allowedStreamHosts = ['webcast.go.kr', 'assembly.go.kr', 'hscdn.com'];
export const defaultListUrl = 'https://assembly.webcast.go.kr/main/service/live_list.asp';

function requiredUrl(value, protocol, label, allowedDomains = allowedStreamHosts) {
  let url;
  try { url = new URL(value); } catch { throw Error(`${label} 주소가 올바르지 않습니다.`); }
  if (url.protocol !== protocol) throw Error(`${label} 주소는 ${protocol} 주소여야 합니다.`);
  if (allowedDomains && !allowedDomains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    throw Error(`${label} 호스트가 허용되지 않습니다.`);
  }
  return url.href;
}

export function broadcastStreamUrl(value) {
  return requiredUrl(value, 'https:', '방송 스트림');
}

export function parseBroadcastPage(value, pageUrl) {
  if (!value || typeof value !== 'object') throw Error('방송 페이지 응답이 JSON 객체가 아닙니다.');
  const websocketBase = value.xsami ? requiredUrl(value.xsami, 'wss:', '자막 WebSocket').replace(/\/+$/, '') : '';
  const streams = Array.isArray(value.xhls) ? value.xhls[0] : null;
  const audioUrl = requiredUrl(streams?.['240p'] || streams?.default, 'https:', '방송 오디오');
  const videoSources = [];
  for (const height of [240, 480, 720, 1080]) {
    if (!streams?.[`${height}p`]) continue;
    try { videoSources.push({ height, url: broadcastStreamUrl(streams[`${height}p`]) }); } catch {}
  }
  if (!videoSources.length) videoSources.push({ height: 0, url: audioUrl });
  return {
    source: websocketBase ? (websocketBase.endsWith('/hls') ? websocketBase : `${websocketBase}/hls`) : null,
    audioUrl,
    videoSources,
    pageUrl,
    broadcast: {
      committee: typeof value.xfull === 'string' ? value.xfull : '',
      subject: typeof value.xsubj === 'string' ? value.xsubj : '',
      status: typeof value.xstat === 'string' ? value.xstat : '',
      updatedAt: typeof value.qtime === 'string' ? value.qtime : '',
    },
  };
}

export async function loadBroadcastPage(pageUrl, fetchImpl = fetch) {
  const parsed = new URL(pageUrl);
  if (parsed.protocol !== 'https:' || parsed.hostname !== allowedHost) {
    throw Error(`방송 페이지는 https://${allowedHost}/ 주소여야 합니다.`);
  }
  const response = await fetchImpl(parsed, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error(`방송 페이지 요청 실패 (${response.status})`);
  return parseBroadcastPage(await response.json(), parsed.href);
}

export function parseBroadcastList(value, listUrl = defaultListUrl) {
  if (!value || !Array.isArray(value.xlist)) throw Error('방송 목록 응답에 xlist 배열이 없습니다.');
  const base = new URL(listUrl);
  return value.xlist.map(item => {
    const id = typeof item.xcode === 'string' ? item.xcode : '';
    const schedule = typeof item.xcgcd === 'string' ? item.xcgcd.trim() : '';
    const pageUrl = id && schedule ? new URL(`live_play.asp?xcode=${encodeURIComponent(id)}&xcgcd=${encodeURIComponent(schedule)}`, base).href : null;
    return {
      id,
      name: typeof item.xname === 'string' ? item.xname : id,
      onAir: item.xstat === '1',
      subject: typeof item.xsubj === 'string' ? item.xsubj : '',
      statusText: typeof item.xdesc === 'string' ? item.xdesc : '',
      pageUrl,
    };
  }).filter(item => item.id && item.name)
    .sort((left, right) => Number(left.statusText.trim() === '생중계 없음') -
      Number(right.statusText.trim() === '생중계 없음'));
}

export async function loadBroadcastList(listUrl = defaultListUrl, fetchImpl = fetch) {
  const parsed = new URL(listUrl);
  if (parsed.protocol !== 'https:' || parsed.hostname !== allowedHost) {
    throw Error(`방송 목록은 https://${allowedHost}/ 주소여야 합니다.`);
  }
  const response = await fetchImpl(parsed, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error(`방송 목록 요청 실패 (${response.status})`);
  return { channels: parseBroadcastList(await response.json(), parsed.href), listUrl: parsed.href };
}
