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

test('자동은 1080p에서 시작하고 안정적인 동안 1080p를 유지하며 2160p 등 허용 범위 밖의 화질은 제외한다', () => {
  const { auto, step } = setup();
  assert.equal(auto.height, 1080);
  assert.equal(auto.reason, '1080p에서 시작');
  for (let index = 0; index < 20; index++) assert.equal(step(), null);
  assert.equal(auto.height, 1080);
});

for (const [reason, firstSample, secondSample = firstSample] of [
  ['버퍼 소진', { buffer: 0.3 }],
  ['대역폭 하락', { bandwidth: 1000000 }],
  ['프레임 드롭', { droppedFrames: 50 }, { droppedFrames: 100 }],
  ['데이터 절약', { saveData: true }],
  ['재생 정체', { currentTime: 0 }],
]) {
  test(`${reason} 감지 즉시 대기 없이 한 단계씩 하향하고 480p 아래로는 내려가지 않는다`, () => {
    const { auto, step } = setup();
    assert.equal(auto.height, 1080);
    assert.equal(step(firstSample), 720);
    assert.equal(auto.height, 720);
    assert.equal(step(secondSample), 480);
    assert.equal(auto.height, 480);
    for (let index = 0; index < 10; index++) assert.equal(step(secondSample), null);
    assert.equal(auto.height, 480);
  });
}

test('이미 회복된 버퍼링은 하향하지 않고 버퍼가 부족한 정체는 즉시 하향한다', () => {
  const { auto, step } = setup();
  auto.stall();
  assert.equal(step({ buffer: 8 }), null);
  assert.equal(auto.height, 1080);
  auto.stall();
  assert.equal(step({ buffer: 1.5 }), 720);
  assert.equal(auto.height, 720);
});

test('상위 화질 연결 실패는 한 단계씩 복귀하며 480p 아래로 자동 하향하지 않는다', () => {
  const { auto } = setup();
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
