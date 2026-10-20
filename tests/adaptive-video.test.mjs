import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoQuality } from '../adaptive-video.mjs';

function setup() {
  let now = 0, frames = 0;
  const channel = { videoDefaultUrl: 'https://cdn.test/480',
    videoSources: [240, 480, 720, 1080, 2160].map(height => ({ height, url: `https://cdn.test/${height}` })) };
  const auto = createAutoQuality(channel, () => now);
  return { auto, channel, step(overrides = {}, milliseconds = 5000) {
    now += milliseconds; frames += 150;
    return auto.sample({ buffer: 6, bandwidth: 20000000, bitrate: 5000000,
      totalFrames: frames, droppedFrames: 0, currentTime: now / 1000, ...overrides });
  } };
}

test('자동은 480p에서 시작하고 충분한 측정·대기 후 720p·1080p로 한 단계씩 상승한다', () => {
  const { auto, step } = setup();
  assert.equal(auto.height, 480);
  assert.equal(step(), null); assert.equal(step(), null); assert.equal(step(), null);
  assert.equal(step(), 720);
  auto.resume();
  assert.equal(step(), null); assert.equal(step(), null); assert.equal(step(), null);
  assert.equal(step(), 1080);
  for (let index = 0; index < 20; index++) assert.equal(step(), null);
  assert.equal(auto.height, 1080, '2160p 등 허용 범위 밖의 화질로는 올리지 않는다');
});

for (const [reason, sample] of [
  ['느린 다운로드', { bandwidth: 2000000 }], ['버퍼 부족', { buffer: 1.5 }],
  ['데이터 절약', { saveData: true }], ['재생 정체', { currentTime: 0 }],
]) {
  test(`${reason}에서는 화질을 올리지 않는다`, () => {
    const { auto, step } = setup();
    for (let index = 0; index < 20; index++) assert.equal(step(sample), null);
    assert.equal(auto.height, 480);
  });
}

test('속도 측정이 없는 기본 HLS에서는 더 긴 안정 구간을 확인한 후 상승한다', () => {
  const { auto, step } = setup();
  for (let index = 0; index < 6; index++) assert.equal(step({ bandwidth: NaN }), null);
  assert.equal(step({ bandwidth: NaN }), 720);
  assert.equal(auto.height, 720);
});

for (const [reason, sample] of [
  ['버퍼 소진', { buffer: 0.3 }], ['대역폭 하락', { bandwidth: 1000000 }],
  ['프레임 드롭', { droppedFrames: 50 }],
]) {
  test(`${reason} 시 하향하고 바로 재상승하지 않는다`, () => {
    const { auto, step } = setup();
    for (let index = 0; index < 4; index++) step();
    assert.equal(auto.height, 720);
    step();
    assert.equal(step(sample), 480);
    for (let index = 0; index < 11; index++) assert.equal(step(), null);
    assert.equal(auto.height, 480);
    assert.equal(step(), 720, '하향 후 최소 60초가 지나면 다시 시도한다');
  });
}

test('480p에서 버퍼링을 겪어도 안정화 뒤에는 다시 상승할 수 있다', () => {
  const { auto, step } = setup();
  auto.stall(); assert.equal(step(), null);
  for (let index = 0; index < 10; index++) assert.equal(step(), null);
  assert.equal(step(), 720);
});

test('상위 화질 연결 실패는 한 단계씩 복귀하며 480p 아래로 자동 하향하지 않는다', () => {
  const { auto, step } = setup();
  for (let index = 0; index < 8; index++) step();
  assert.equal(auto.height, 1080);
  assert.equal(auto.fallback(), 720);
  assert.equal(auto.fallback(), 480);
  assert.equal(auto.fallback(), null);
});

test('독립 화질 주소가 없는 채널과 원본 다중 화질 master는 기존 재생에 맡긴다', () => {
  assert.equal(createAutoQuality({}), null);
  const { channel } = setup();
  channel.videoDefaultUrl = 'https://cdn.test/master';
  assert.equal(createAutoQuality(channel), null);
});
