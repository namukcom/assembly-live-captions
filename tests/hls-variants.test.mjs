import test from 'node:test';
import assert from 'node:assert/strict';
import { originalVariantLoader } from '../hls-variants.mjs';

const sources = [480, 720, 1080].map(height => ({ height, url: `https://cdn.test/${height}/playlist.m3u8?original=1` }));
const playlist = (height, codecs = 'avc1.4d4028,mp4a.40.2') => `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=${height * 4000},RESOLUTION=${height * 2}x${height},CODECS="${codecs}"\nchunklist.m3u8?session=origin\n`;
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(fetchImpl, text = playlist(480)) {
  class Base {
    load(context, config, callbacks) { this.context = context; this.promise = callbacks.onSuccess({ data: text, url: context.url }, {}, context, {}); }
    abort() { this.aborted = true; }
    destroy() { this.destroyed = true; }
  }
  const Loader = originalVariantLoader({ DefaultConfig: { loader: Base } }, sources, fetchImpl);
  const loader = new Loader({});
  const responses = [];
  loader.load({ type: 'manifest', url: sources[0].url }, {}, { onSuccess(response) { responses.push(response); } });
  return { loader, responses };
}

test('원본 메타데이터로 브라우저에서 화질을 등록하고 원본 하위 주소의 쿼리를 보존한다', async () => {
  const requests = [];
  const { loader, responses } = setup(async (url, options) => {
    requests.push(url); assert.equal(options.credentials, 'omit');
    const height = sources.find(source => source.url === url).height;
    return { ok: true, text: async () => playlist(height) };
  });
  await loader.promise;
  assert.deepEqual(requests, sources.slice(1).map(source => source.url));
  assert.equal(responses.length, 1);
  assert.equal((responses[0].data.match(/#EXT-X-STREAM-INF/g) || []).length, 3);
  for (const height of [480, 720, 1080]) assert.ok(responses[0].data.includes(`https://cdn.test/${height}/chunklist.m3u8?session=origin`));
});

test('상위 화질 조회 실패나 호환되지 않는 코덱은 원본 480p 재생을 막지 않는다', async () => {
  const { loader, responses } = setup(async url => {
    if (url.includes('/720/')) throw Error('offline');
    return { ok: true, text: async () => playlist(1080, 'hvc1.1.6.L120.B0,mp4a.40.2') };
  });
  await loader.promise;
  assert.equal(responses.length, 1);
  assert.equal((responses[0].data.match(/#EXT-X-STREAM-INF/g) || []).length, 1);
  assert.ok(responses[0].data.includes('/480/chunklist.m3u8'));
});

for (const method of ['abort', 'destroy']) {
test(`${method}: 진행 중인 조회를 취소하고 늦은 응답은 전달하지 않는다`, async () => {
  const pending = [], signals = [];
  const { loader, responses } = setup((url, options) => new Promise(resolve => {
    signals.push(options.signal); pending.push(() => resolve({ ok: true, text: async () => playlist(url.includes('/720/') ? 720 : 1080) }));
  }));
  await settle(); loader[method]();
  assert.ok(signals.every(signal => signal.aborted));
  pending.forEach(finish => finish()); await loader.promise;
  assert.deepEqual(responses, []);
});
}

test('이미 다중 화질인 원본은 추가 요청이나 변형 없이 사용한다', async () => {
  const original = playlist(480) + playlist(720);
  const { loader, responses } = setup(() => { throw Error('Unexpected request'); }, original);
  await loader.promise;
  assert.equal(responses[0].data, original);
});
