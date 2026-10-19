import { broadcastStreamUrl } from './broadcast-config.mjs';

// Only playlist metadata passes through this server. Segments stay on the original CDN.
export async function createVideoManifest(sources, fetchImpl = fetch) {
  const results = await Promise.allSettled(sources.map(async source => {
    const url = broadcastStreamUrl(source.url);
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw Error(`방송 목록 요청 실패 (${response.status})`);
    const text = await response.text();
    if (text.length > 65536 || !text.trimStart().startsWith('#EXTM3U')) throw Error('잘못된 방송 목록');
    const lines = text.split(/\r?\n/).map(line => line.trim());
    const index = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF:'));
    if (index < 0) throw Error('화질 정보가 없는 방송 목록');
    const attributes = lines[index];
    const bandwidth = attributes.match(/\bBANDWIDTH=(\d+)/)?.[1];
    const resolution = attributes.match(/\bRESOLUTION=(\d+x\d+)/)?.[1];
    const codecs = attributes.match(/\bCODECS="([a-zA-Z0-9., -]+)"/)?.[1];
    const uri = lines.slice(index + 1).find(line => line && !line.startsWith('#'));
    if (!bandwidth || !uri || !codecs || !resolution) throw Error('불완전한 화질 정보');
    const mediaUrl = broadcastStreamUrl(new URL(uri, url).href);
    return { bandwidth: Number(bandwidth), tag: `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="${codecs}",RESOLUTION=${resolution}`, url: mediaUrl };
  }));
  const variants = results.filter(result => result.status === 'fulfilled').map(result => result.value)
    .sort((a, b) => a.bandwidth - b.bandwidth);
  if (!variants.length) throw Object.assign(Error('영상 재생 주소를 불러오지 못했습니다. 다시 시도하세요.'), { status: 502 });
  return ['#EXTM3U', '#EXT-X-VERSION:3', ...variants.flatMap(variant => [variant.tag, variant.url]), ''].join('\n');
}
