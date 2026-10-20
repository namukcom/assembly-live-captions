// Decisions only: playback, cancellation, and resource ownership stay in media.mjs.
export function createAutoQuality(channel) {
  const sources = channel?.videoSources || [];
  const heights = [...new Set(sources.map(source => source.height).filter(height => [480, 720, 1080].includes(height)))].sort((a, b) => a - b);
  // A separate original master can already provide its own adaptive variants.
  if (!heights.length || (channel.videoDefaultUrl && !sources.some(source => source.url === channel.videoDefaultUrl))) return null;
  let index = heights.length - 1, frames = { total: 0, dropped: 0 }, time = 0, stalled = false, reason = `${heights[index]}p에서 시작`;
  function change(next, cause) {
    index = next; reason = cause; stalled = false;
    return heights[index];
  }
  return {
    get height() { return heights[index]; },
    get reason() { return reason; },
    resume() { if (frames?.total) frames = null; if (time) time = null; stalled = false; },
    stall() { stalled = true; },
    fallback() { return index > 0 ? change(index - 1, '원본 연결 오류') : null; },
    sample({ buffer, bandwidth, bitrate, totalFrames, droppedFrames, currentTime, saveData = false }) {
      const elapsedFrames = frames && totalFrames >= frames.total ? totalFrames - frames.total : 0;
      const dropped = frames && droppedFrames >= frames.dropped ? droppedFrames - frames.dropped : 0;
      frames = Number.isFinite(totalFrames) && Number.isFinite(droppedFrames) ? { total: totalFrames, dropped: droppedFrames } : null;
      const progressing = time !== null && currentTime > time;
      const frozen = time !== null && !progressing;
      time = currentTime;
      const dropRatio = elapsedFrames >= 60 ? dropped / elapsedFrames : 0;
      const measured = Number.isFinite(bandwidth) && bandwidth > 0 && Number.isFinite(bitrate) && bitrate > 0;
      const buffering = buffer < 1 || frozen || (stalled && buffer < 2);
      stalled = false;
      const cause = buffering ? '버퍼 부족' : dropRatio > 0.05 ? '프레임 드롭' : measured && bandwidth < bitrate * 1.1 ? '다운로드 속도 부족' : saveData ? '데이터 절약' : '';
      return cause && index > 0 ? change(index - 1, cause) : null;
    },
  };
}
