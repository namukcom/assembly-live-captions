export function seoulDay(value = Date.now()) {
  return new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function seoulSlot(value = Date.now()) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  const interval = 5 * 60 * 1000;
  const slot = Math.floor(time / interval) * interval;
  return new Date(slot + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

export function isDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function parseCaption(raw) {
  let message;
  try { message = JSON.parse(raw); } catch {
    return raw.trim() ? { text: raw, final: null, segment: null, offset: null } : null;
  }
  if (!message || typeof message !== 'object') return null;
  const lines = Array.isArray(message.transcripts) ? message.transcripts
    .filter(line => Array.isArray(line) && typeof line[1] === 'string')
    .map(line => line[1].trim()) : [];
  const text = lines.length ? lines.join('\n') :
    typeof message.transcript === 'string' ? message.transcript :
    typeof message.text === 'string' ? message.text : '';
  if (!text.trim()) return null;
  return {
    text,
    final: typeof message.final === 'boolean' ? message.final : null,
    segment: ['number', 'string'].includes(typeof message.segment) ? String(message.segment) : null,
    offset: ['number', 'string'].includes(typeof message['segment-offset']) ? String(message['segment-offset']) : null,
  };
}
