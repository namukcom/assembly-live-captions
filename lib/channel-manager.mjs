import { CaptionCollector } from './collector.mjs';
import { defaultListUrl, loadBroadcastList, loadBroadcastPage } from './broadcast-config.mjs';

export class ChannelManager {
  constructor({ store, listUrl = defaultListUrl, refreshMs = 30000, fetchImpl = fetch,
    WebSocketClass, onEvent = () => {}, onStatus = () => {}, onFatal = () => {} }) {
    Object.assign(this, { store, listUrl, refreshMs, fetchImpl, WebSocketClass, onEvent, onStatus, onFatal });
    this.items = new Map();
    this.collectors = new Map();
    this.running = false;
    this.refreshing = null;
    this.refreshedAt = null;
    this.lastError = null;
  }

  snapshot() {
    return {
      channels: [...this.items.values()].map(item => {
        const { historySources, ...channel } = item;
        return { ...channel, collector: this.collectors.get(item.id)?.state ?? null };
      }),
      refreshedAt: this.refreshedAt,
      lastError: this.lastError,
      refreshMs: this.refreshMs,
    };
  }

  get(id) { return this.items.get(String(id)); }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.refresh();
    if (this.running) this.timer = setInterval(() => this.refresh(), this.refreshMs);
  }

  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshNow().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async refreshNow() {
    try {
      const { channels } = await loadBroadcastList(this.listUrl, this.fetchImpl);
      const previous = this.items;
      const next = new Map(channels.map(channel => {
        const historySources = this.store.sourcesForChannel(channel.id);
        const old = previous.get(channel.id);
        const samePage = Boolean(channel.pageUrl && old?.pageUrl === channel.pageUrl);
        return [channel.id, { ...old, ...channel,
          audioUrl: samePage ? old?.audioUrl || null : null,
          videoSources: samePage ? old?.videoSources || [] : [],
          broadcast: samePage ? old?.broadcast || null : null,
          source: old?.source || historySources.at(-1) || null,
          historySources: [...new Set([...(old?.historySources || []), ...historySources])],
        }];
      }));
      const scheduled = channels.filter(channel => channel.pageUrl);
      await Promise.all(scheduled.map(async channel => {
        try {
          const old = previous.get(channel.id);
          const existing = this.collectors.get(channel.id);
          if (channel.onAir && old?.pageUrl === channel.pageUrl && old?.source && existing?.source === old.source &&
              existing.state.state === 'connected') {
            next.set(channel.id, { ...old, ...channel, source: old.source, audioUrl: old.audioUrl,
              broadcast: old.broadcast, historySources: next.get(channel.id).historySources });
            return;
          }
          const config = await loadBroadcastPage(channel.pageUrl, this.fetchImpl);
          if (channel.onAir) this.store.rememberChannelSource(channel.id, config.source);
          const item = { ...next.get(channel.id), ...config,
            source: channel.onAir ? config.source : next.get(channel.id).source,
            historySources: [...new Set([...(next.get(channel.id).historySources || []),
              ...(channel.onAir && config.source ? [config.source] : [])])],
            loadError: null,
          };
          next.set(channel.id, item);
          if (!channel.onAir || !config.source) return;
          if (existing?.source === config.source) return;
          existing?.stop();
          const collector = new CaptionCollector({ source: config.source, channelId: channel.id, store: this.store,
            WebSocketClass: this.WebSocketClass,
            onEvent: value => this.onEvent(channel.id, value),
            onStatus: value => this.onStatus(channel.id, value),
          });
          collector.onFatal = this.onFatal;
          this.collectors.set(channel.id, collector);
          if (this.running) collector.start();
        } catch (error) {
          next.set(channel.id, { ...next.get(channel.id),
            loadError: error.message });
        }
      }));
      for (const [id, collector] of this.collectors) {
        if (next.get(id)?.onAir && next.get(id)?.source) continue;
        collector.stop(); this.collectors.delete(id);
      }
      this.items = next;
      this.refreshedAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
    }
    return this.snapshot();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    for (const collector of this.collectors.values()) collector.stop();
    this.collectors.clear();
  }
}
