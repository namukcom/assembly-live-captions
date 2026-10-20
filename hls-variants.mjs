const defaultWidths = { 240: 426, 480: 854, 720: 1280, 1080: 1920 };

function variant(text, source, xhlsHeight = 0) {
  if (typeof text !== 'string' || text.length > 65536 || !text.trimStart().startsWith('#EXTM3U')) return null;
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const tags = lines.filter(line => line.startsWith('#EXT-X-STREAM-INF:'));
  if (tags.length !== 1 || /(?:^|,)(?:AUDIO|SUBTITLES)=/.test(tags[0])) return null;
  const index = lines.indexOf(tags[0]);
  const uri = lines.slice(index + 1).find(line => line && !line.startsWith('#'));
  const bitrate = Number(tags[0].match(/\bBANDWIDTH=(\d+)/)?.[1]);
  const codecs = tags[0].match(/\bCODECS="([^"]+)"/)?.[1];
  const height = Number(xhlsHeight) || Number(tags[0].match(/\bRESOLUTION=\d+x(\d+)/)?.[1]);
  if (!uri || !bitrate || !codecs || ![480, 720, 1080].includes(height)) return null;
  const url = new URL(uri, source);
  if (url.protocol !== 'https:') return null;
  const tag = /\bRESOLUTION=\d+x\d+/.test(tags[0]) ? tags[0] :
    `${tags[0]},RESOLUTION=${defaultWidths[height] || Math.round(height * 16 / 9)}x${height}`;
  return { tag, url: url.href, bitrate, codecs, height };
}

// Expand the initial original master only in the browser's playlist loader.
// HLS keeps one MediaSource and decodes rendition changes at fragment boundaries.
export function originalVariantLoader(Hls, sources, fetchImpl = fetch) {
  return class extends Hls.DefaultConfig.loader {
    constructor(config) { super(config); this.variantAbort = null; }
    abort() { this.variantAbort?.abort(); this.variantAbort = null; super.abort(); }
    destroy() { this.variantAbort?.abort(); this.variantAbort = null; super.destroy(); }
    load(context, config, callbacks) {
      if (context.type !== 'manifest') return super.load(context, config, callbacks);
      return super.load(context, config, { ...callbacks, onSuccess: async (response, stats, loadedContext, details) => {
        this.variantAbort?.abort();
        const controller = new AbortController(); this.variantAbort = controller;
        const timer = setTimeout(() => controller.abort(), 5000);
        let combined = response;
        try {
          const loadedUrl = response.url || context.url;
          const firstSource = sources?.find(source => source.url === loadedUrl || source.url === context.url);
          const first = variant(response.data, loadedUrl, firstSource?.height);
          if (first) {
            const other = sources.filter(source => [480, 720, 1080].includes(source.height) && source.height !== first.height);
            const results = await Promise.allSettled(other.map(async source => {
              const result = await fetchImpl(source.url, { signal: controller.signal, credentials: 'omit', redirect: 'error' });
              if (!result.ok) return null;
              return variant(await result.text(), result.url || source.url, source.height);
            }));
            const variants = [first, ...results.filter(result => result.status === 'fulfilled').map(result => result.value)]
              .filter(item => item && item.codecs === first.codecs)
              .filter((item, index, items) => items.findIndex(other => other.height === item.height) === index)
              .sort((a, b) => a.height - b.height || a.bitrate - b.bitrate);
            combined = { ...response, data: ['#EXTM3U', ...variants.flatMap(item => [item.tag, item.url]), ''].join('\n') };
          }
        } catch { /* Keep the original playlist if optional rendition discovery fails. */ }
        finally { clearTimeout(timer); }
        // destroy/abort must prevent a late response from reattaching a stopped player.
        if (this.variantAbort !== controller) return;
        this.variantAbort = null;
        callbacks.onSuccess(combined, stats, loadedContext, details);
      } });
    }
  };
}
