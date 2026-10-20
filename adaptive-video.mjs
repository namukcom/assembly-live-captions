// Decisions only: playback, cancellation, and resource ownership stay in media.mjs.
export function createAutoQuality(channel, now = () => performance.now()) {
  const sources = channel?.videoSources || [];
  const heights = [...new Set(sources.map(source => source.height).filter(height => [480, 720, 1080].includes(height)))].sort((a, b) => a - b);
  // A separate original master can already provide its own adaptive variants.
  if (!heights.length || (channel.videoDefaultUrl && !sources.some(source => source.url === channel.videoDefaultUrl))) return null;
  let index = 0, changedAt = now(), upgradeAfter = changedAt + 20000, healthy = 0;
  let frames = null, time = null, stalled = false, badSamples = 0, lastCause = '', reason = '480p에서 시작';
  function resetSamples() { healthy = 0; frames = null; time = null; badSamples = 0; lastCause = ''; }
  function change(next, recovering = false, cause = '재생 안정·대역폭 여유') {
    index = next; changedAt = now();
    reason = cause;
    upgradeAfter = changedAt + (recovering ? 60000 : 20000);
    resetSamples(); stalled = false;
    return heights[index];
  }
  return {
    get height() { return heights[index]; },
    get reason() { return reason; },
    resume() { resetSamples(); upgradeAfter = Math.max(upgradeAfter, now() + 15000); },
    stall() { stalled = true; healthy = 0; upgradeAfter = now() + 60000; },
    fallback() { return index > 0 ? change(index - 1, true, '원본 연결 오류') : null; },
    sample({ buffer, bandwidth, bitrate, totalFrames, droppedFrames, currentTime, saveData = false }) {
      const elapsedFrames = frames && totalFrames >= frames.total ? totalFrames - frames.total : 0;
      const dropped = frames && droppedFrames >= frames.dropped ? droppedFrames - frames.dropped : 0;
      frames = Number.isFinite(totalFrames) && Number.isFinite(droppedFrames) ? { total: totalFrames, dropped: droppedFrames } : null;
      const progressing = time !== null && currentTime > time;
      time = currentTime;
      const dropRatio = elapsedFrames >= 60 ? dropped / elapsedFrames : 0;
      const measured = Number.isFinite(bandwidth) && bandwidth > 0 && Number.isFinite(bitrate) && bitrate > 0;
      const buffering = buffer < 1 || (stalled && !progressing && buffer < 2);
      const cause = buffering ? '버퍼 부족' : dropRatio > 0.05 ? '프레임 드롭' : measured && bandwidth < bitrate * 1.1 ? '다운로드 속도 부족' : '';
      badSamples = cause && cause === lastCause ? badSamples + 1 : cause ? 1 : 0;
      lastCause = cause;
      stalled = false;
      if (cause) {
        healthy = 0;
        if (index > 0 && (buffering || badSamples >= 2) && now() - changedAt >= 10000) return change(index - 1, true, cause);
        return null;
      }
      if (!progressing || !Number.isFinite(buffer) || buffer < 2 || dropRatio > 0.01 || saveData) { healthy = 0; return null; }
      healthy++;
      if (index === heights.length - 1 || now() < upgradeAfter || healthy < 3) return null;
      // Estimate the next rendition conservatively from current encoded bitrate and pixels.
      // Without network measurements (native HLS), require a longer stable period.
      const nextBitrate = bitrate * (heights[index + 1] / heights[index]) ** 2;
      if (measured ? bandwidth < nextBitrate * 1.5 : healthy < 6) return null;
      return change(index + 1);
    },
  };
}
