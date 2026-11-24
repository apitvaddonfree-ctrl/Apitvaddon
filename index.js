'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { XMLParser } = require('fast-xml-parser');
const { configureHttp, clampInt, safeHttpUrl } = require('./http.cjs');
const { createXtreamClient, loadXtreamSources, normalizeXtreamSource } = require('./xtream.cjs');

const CONFIG_DIR = path.join(__dirname, 'config');
const APP_CONFIG_FILE = path.join(CONFIG_DIR, 'app-config.json');
const EPG_CONFIG_FILE = path.join(CONFIG_DIR, 'epg.json');
const CHANNELS_DEFAULT = path.join(__dirname, 'data', 'embedTV.json');
const EMBED_CANAIS_HOME_DEFAULT = 'https://embedcanais.online/';
const XML_PARSER = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', parseTagValue: false, trimValues: true });

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function readAppConfig(file = APP_CONFIG_FILE) { return readJson(file); }
function readChannelData(filename = CHANNELS_DEFAULT) {
  const parsed = readJson(filename);
  if (!Array.isArray(parsed.channels)) throw new Error('O catálogo de canais precisa conter channels[].');
  return parsed;
}
function resolveChannelsFile(config, explicit) {
  if (explicit) return explicit;
  const configured = String(config.EMBEDTV_FALLBACK_FILE || '').trim();
  if (configured) {
    const candidate = path.resolve(__dirname, configured);
    const relative = path.relative(__dirname, candidate);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(candidate)) return candidate;
  }
  return CHANNELS_DEFAULT;
}
function loadEpgSources(file = EPG_CONFIG_FILE) {
  const sources = readJson(file);
  if (!Array.isArray(sources) || sources.length > 10) throw new Error('config/epg.json deve ter no máximo 10 fontes.');
  return sources.map((entry, index) => {
    const url = safeHttpUrl(typeof entry === 'string' ? entry : entry?.url, `fonte EPG ${index + 1}`);
    return { id: String(entry?.id || `epg-${index + 1}`).slice(0, 64), url: url.toString() };
  });
}
function textValue(value) {
  if (Array.isArray(value)) return textValue(value[0]);
  if (value && typeof value === 'object') return String(value['#text'] || value.value || '');
  return String(value || '');
}
function asArray(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function xmltvTime(value) {
  const match = String(value || '').trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, sign, offH, offM] = match;
  const local = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const offset = sign ? (+offH * 60 + +offM) * 60000 * (sign === '+' ? 1 : -1) : 0;
  return new Date(local - offset).toISOString();
}
function parseEpgXml(xml, sourceId) {
  const root = XML_PARSER.parse(xml)?.tv || {};
  const channels = asArray(root.channel).map((c) => ({ id: String(c?.['@_id'] || '').slice(0, 200), name: textValue(c?.['display-name']) || String(c?.['@_id'] || '').slice(0, 200), sourceId })).filter((c) => c.id);
  const programmes = asArray(root.programme).map((p) => ({ channel: String(p?.['@_channel'] || '').slice(0, 200), start: xmltvTime(p?.['@_start']), stop: xmltvTime(p?.['@_stop']), title: textValue(p?.title).slice(0, 300), description: textValue(p?.desc).slice(0, 3000), category: textValue(p?.category).slice(0, 120), sourceId })).filter((p) => p.channel && p.start && p.title);
  return { channels, programmes };
}
function mapStaticChannel(channel) {
  let sourceUrl = '';
  try { sourceUrl = safeHttpUrl(channel.url, 'URL do canal').toString(); } catch { /* catálogo ainda pode exibir o canal */ }
  return { id: String(channel.id || ''), name: String(channel.name || '').slice(0, 200), image: String(channel.image || '').slice(0, 2000), preview: String(channel.preview || '').slice(0, 2000), categories: Array.isArray(channel.categories) ? channel.categories : [], categoryNames: Array.isArray(channel.categoryNames) ? channel.categoryNames.map(String) : [], source: 'embedtv', sourceUrl, playbackMode: 'external-page' };
}
function arrayPayload(payload, keys = ['channels', 'events', 'sports', 'results', 'items']) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
  if (Array.isArray(payload?.data)) return payload.data;
  if (payload?.data && typeof payload.data === 'object') return arrayPayload(payload.data, keys);
  return [];
}
function mapEmbedChannels(payload) {
  const categoryNames = new Map((Array.isArray(payload?.categories) ? payload.categories : []).map((item) => [String(item.id), String(item.name || item.title || '')]));
  return arrayPayload(payload).map((channel) => {
    const categories = (Array.isArray(channel.categories) ? channel.categories : []).map((category) => {
      if (category && typeof category === 'object') return String(category.name || category.title || category.id || '');
      return categoryNames.get(String(category)) || String(category || '');
    }).filter(Boolean);
    const mapped = mapStaticChannel({
      id: channel.id,
      name: channel.name || channel.title,
      image: channel.image || channel.logo,
      preview: channel.preview,
      categories,
      categoryNames: categories,
      url: channel.url || channel.sourceUrl || channel.href
    });
    const normalized = `${mapped.id} ${mapped.name}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (!mapped.id || !mapped.sourceUrl || /\b(playboy|sexyhot)\b/.test(normalized)) return null;
    return { ...mapped, playbackMode: /\.m3u8(?:$|\?)/i.test(mapped.sourceUrl) ? 'hls' : 'external-page' };
  }).filter(Boolean);
}

function extractEmbedCanaisArray(html) {
  const text = String(html || '');
  const marker = /const\s+CHANNELS\s*=/g;
  const found = marker.exec(text);
  if (!found) throw new Error('Catálogo Embed Canais não encontrado');
  const start = text.indexOf('[', found.index + found[0].length);
  if (start < 0) throw new Error('Catálogo Embed Canais sem lista');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, index + 1));
    }
  }
  throw new Error('Catálogo Embed Canais truncado');
}

function mapEmbedCanaisChannels(payload) {
  const raw = Array.isArray(payload) ? payload : arrayPayload(payload);
  return raw.map((channel) => {
    const name = String(channel?.name || channel?.title || channel?.slug || '').trim().slice(0, 200);
    const slug = String(channel?.slug || channel?.id || name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
    let sourceUrl = '';
    try { sourceUrl = safeHttpUrl(channel?.href || channel?.url || channel?.sourceUrl || channel?.source_url || channel?.embed_url, 'URL Embed Canais').toString(); } catch { return null; }
    if (!name || !slug) return null;
    const category = String(channel?.category || channel?.categoryName || 'Outros').trim().slice(0, 120) || 'Outros';
    const image = String(channel?.image || channel?.logo || '').slice(0, 2000);
    return {
      id: `embedcanais-${slug}`, slug, name, title: name, category,
      categories: [category], categoryNames: [category], categoryName: category,
      image, logo_url: image, source: 'embedcanais', source_name: 'Embed Canais',
      sourceUrl, source_url: sourceUrl, url: sourceUrl, href: sourceUrl,
      playbackMode: /\.m3u8(?:$|[?#])/i.test(sourceUrl) ? 'hls' : 'external-page'
    };
  }).filter(Boolean);
}

function createApp({ fetchImpl = globalThis.fetch, appConfigFile = APP_CONFIG_FILE, epgConfigFile = EPG_CONFIG_FILE, channelsFile = null, xtreamSources = null, logger = console } = {}) {
  const config = readAppConfig(appConfigFile);
  const localChannelsFile = resolveChannelsFile(config, channelsFile);
  const channelData = readChannelData(localChannelsFile);
  const staticChannels = channelData.channels.map(mapStaticChannel).filter((c) => c.id);
  const staticCategories = Array.isArray(channelData.categories) ? channelData.categories : [];
  const epgSources = loadEpgSources(epgConfigFile);
  const liveBase = safeHttpUrl(config.LIVE_TV_API_BASE, 'LIVE_TV_API_BASE').toString().replace(/\/+$/, '');
  const embedBase = safeHttpUrl(config.EMBEDTV_API_BASE, 'EMBEDTV_API_BASE').toString().replace(/\/+$/, '');
  const timeoutMs = clampInt(config.DIRECT_PROVIDER_API_TIMEOUT_MS || config.PROVIDER_SOURCE_TIMEOUT_MS, 25000, 1000, 120000);
  const embedCanaisUrl = safeHttpUrl(config.EMBED_CANAIS_HOME || EMBED_CANAIS_HOME_DEFAULT, 'EMBED_CANAIS_HOME').toString();
  const embedCanaisTimeoutMs = clampInt(config.EMBED_CANAIS_TIMEOUT_MS, 25000, 1000, 120000);
  const cacheMs = clampInt(config.LIVE_TV_CACHE_MS, 300000, 0, 3600000);
  const configuredXtreamSources = xtreamSources == null
    ? loadXtreamSources({ appConfig: config })
    : xtreamSources.map(normalizeXtreamSource).filter(Boolean);
  const xtream = createXtreamClient({
    fetchImpl,
    sources: configuredXtreamSources,
    cacheMs,
    concurrency: config.XTREAM_CONCURRENCY || 12,
    logger
  });
  try {
    logger?.info?.(`[xtream] ${JSON.stringify({ event: 'xtream_sources_loaded', count: configuredXtreamSources.length, sourceIds: configuredXtreamSources.map((source) => source.id) })}`);
  } catch { /* Logging must never interrupt startup. */ }
  let liveCache = new Map();
  let embedCache = new Map();
  let epgCache = null;
  let epgInFlight = null;

  const app = express();
  configureHttp(app, 'iracemaflix-tv-api', { rateLimit: 60 });
  app.get('/openapi.json', (_req, res) => res.type('application/json').sendFile(path.join(__dirname, 'openapi.json')));

  async function upstream(base, endpoint, headers = {}) {
    const url = new URL(endpoint, `${base}/`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    try {
      const response = await fetchImpl(url, { headers: { accept: 'application/json, text/plain, */*', 'user-agent': 'IracemaTV/1.5.5', ...headers }, signal: controller.signal });
      if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
      const text = await response.text();
      return JSON.parse(text);
    } finally { clearTimeout(timer); }
  }
  async function cached(key, loader) {
    const hit = liveCache.get(key); if (hit && hit.expires > Date.now()) return hit.value;
    const value = await loader(); if (cacheMs > 0) liveCache.set(key, { value, expires: Date.now() + cacheMs });
    return value;
  }
  async function embed(pathname) {
    const hit = embedCache.get(pathname); if (hit && hit.expires > Date.now()) return hit.value;
    try {
      const value = await upstream(embedBase, pathname, { referer: String(config.EMBEDTV_SOURCE_REFERER || 'https://embedtv.cc/') });
      if (cacheMs > 0) embedCache.set(pathname, { value, expires: Date.now() + cacheMs });
      return value;
    } catch (error) {
      if (pathname === '/api/channels') {
        const fallback = readChannelData(localChannelsFile);
        if (cacheMs > 0) embedCache.set(pathname, { value: fallback, expires: Date.now() + cacheMs });
        return fallback;
      }
      throw error;
    }
  }
  async function getEmbedChannels() {
    return mapEmbedChannels(await embed('/api/channels'));
  }
  async function getEmbedCanaisChannels() {
    return cached('embedcanais-channels', async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), embedCanaisTimeoutMs); timer.unref?.();
      try {
        const response = await fetchImpl(embedCanaisUrl, {
          headers: {
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            referer: embedCanaisUrl,
            'user-agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
          },
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`Embed Canais upstream HTTP ${response.status}`);
        const html = await response.text();
        if (html.length > 2_000_000) throw new Error('Resposta Embed Canais excedeu o limite');
        const items = mapEmbedCanaisChannels(extractEmbedCanaisArray(html));
        if (!items.length) throw new Error('Catálogo Embed Canais vazio');
        return items;
      } finally { clearTimeout(timer); }
    });
  }
  async function fetchEpg(force = false) {
    if (!force && epgCache && epgCache.expires > Date.now()) return epgCache.value;
    if (epgInFlight) return epgInFlight;
    epgInFlight = Promise.all(epgSources.map(async (source) => {
      try { return { id: source.id, data: await upstream(source.url, '', { accept: 'application/xml,text/xml,*/*' }).catch(async () => { throw new Error('EPG upstream'); }) }; } catch { return { id: source.id, failed: true }; }
    })).then((outcomes) => {
      // XMLTV sources are fetched separately because upstream() parses JSON; use the same timeout policy.
      return Promise.all(outcomes.map(async (item) => item));
    }).then((outcomes) => {
      const value = { configured: true, channels: [], programmes: [], failedSources: outcomes.filter((x) => x.failed).map((x) => x.id) };
      if (cacheMs > 0) epgCache = { value, expires: Date.now() + cacheMs }; return value;
    });
    try { return await epgInFlight; } finally { epgInFlight = null; }
  }
  // XMLTV fetcher kept separate from JSON upstreams.
  async function fetchXml(source) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    try { const response = await fetchImpl(source.url, { headers: { accept: 'application/xml,text/xml,*/*' }, signal: controller.signal }); if (!response.ok) throw new Error('upstream'); return parseEpgXml(await response.text(), source.id); } finally { clearTimeout(timer); }
  }
  async function loadEpg(force = false) {
    if (!force && epgCache && epgCache.expires > Date.now()) return epgCache.value;
    const results = await Promise.all(epgSources.map(async (s) => { try { return { id: s.id, data: await fetchXml(s) }; } catch { return { id: s.id, failed: true }; } }));
    const seen = new Set(); const value = { configured: true, channels: results.flatMap((r) => r.data?.channels || []), programmes: results.flatMap((r) => r.data?.programmes || []).filter((p) => { const k = `${p.channel}|${p.start}|${p.title}`; if (seen.has(k)) return false; seen.add(k); return true; }), failedSources: results.filter((r) => r.failed).map((r) => r.id) };
    if (cacheMs > 0) epgCache = { value, expires: Date.now() + cacheMs }; return value;
  }

  async function getLiveChannels() {
    return arrayPayload(await cached('channels', () => upstream(liveBase, '/channels')))
      .map((x) => ({ ...x, source: 'live-tv', playbackMode: x.playbackMode || 'external-page' }));
  }
  function categoriesFromXtream(catalog) {
    if (Array.isArray(catalog.categories) && catalog.categories.length) return catalog.categories;
    const groups = new Map();
    for (const item of catalog.items || []) {
      const name = String(item.categoryName || item.categoryNames?.[0] || '').trim();
      if (!name) continue;
      const sourceId = String(item.sourceId || '');
      const categoryId = String(item.categoryId || name);
      const id = `xtream-${sourceId}-${categoryId}`;
      const current = groups.get(id) || { id, name, source: 'xtream', sourceId, count: 0 };
      current.count += 1;
      groups.set(id, current);
    }
    return [...groups.values()];
  }
  function categoriesFromEmbedCanais(channels) {
    const groups = new Map();
    for (const channel of channels) {
      const name = String(channel.category || channel.categoryName || 'Outros').trim() || 'Outros';
      const id = `embedcanais-${name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const current = groups.get(id) || { id, name, source: 'embedcanais', sourceId: 'embedcanais', count: 0 };
      current.count += 1;
      groups.set(id, current);
    }
    return [...groups.values()];
  }
  app.get('/api/v1/xtream/sources', (_req, res) => res.json({ configured: configuredXtreamSources.length > 0, sources: xtream.listSources() }));
  app.get('/api/v1/categories', async (req, res) => {
    try {
      const source = String(req.query.source || 'all');
      if (!['all', 'embedtv', 'embedcanais', 'xtream'].includes(source)) return res.status(400).json({ error: 'source inválida', requestId: req.requestId });
      let categories = source === 'xtream' || source === 'embedcanais' ? [] : staticCategories;
      let failedSources = [];
      let failedSourceDetails = [];
      let xtreamConfigured = configuredXtreamSources.length > 0;
      if (source === 'embedcanais' || source === 'all') {
        try { categories = [...categories, ...categoriesFromEmbedCanais(await getEmbedCanaisChannels())]; }
        catch { if (source === 'embedcanais') throw new Error('Catálogo Embed Canais indisponível'); failedSources.push('embedcanais'); }
      }
      if (source === 'all' || source === 'xtream') {
        const catalog = await xtream.getCatalog({ sourceId: String(req.query.sourceId || '') });
        categories = [...categories, ...categoriesFromXtream(catalog)];
        failedSources = catalog.failedSources;
        failedSourceDetails = catalog.failedSourceDetails || [];
        xtreamConfigured = catalog.configured;
      }
      const seen = new Set();
      categories = categories.filter((category) => {
        const key = String(category.id || category.name || JSON.stringify(category));
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      res.json({ categories, xtreamConfigured, failedSources, failedSourceDetails });
    } catch { res.status(502).json({ error: 'Não foi possível carregar categorias Xtream', requestId: req.requestId }); }
  });
  app.get('/api/v1/channels', async (req, res) => {
    try {
      const source = String(req.query.source || 'all');
      if (!['all', 'embedtv', 'embedcanais', 'live', 'xtream'].includes(source)) return res.status(400).json({ error: 'source inválida', requestId: req.requestId });
      let items = [];
      let failedSources = [];
      let failedSourceDetails = [];
      let sourceStatus = [];
      let xtreamConfigured = configuredXtreamSources.length > 0;
      if (source === 'embedtv') items = await getEmbedChannels();
      if (source === 'embedcanais') items = await getEmbedCanaisChannels();
      if (source === 'live') items = await getLiveChannels();
      if (source === 'xtream') {
        const catalog = await xtream.getCatalog({ sourceId: String(req.query.sourceId || '') });
        if (catalog.unknownSource) return res.status(404).json({ error: 'Fonte Xtream não configurada', requestId: req.requestId, items: [], total: 0, failedSources: catalog.failedSources, failedSourceDetails: catalog.failedSourceDetails || [] });
        items = catalog.items;
        failedSources = catalog.failedSources;
        failedSourceDetails = catalog.failedSourceDetails || [];
        sourceStatus = catalog.sources;
        xtreamConfigured = catalog.configured;
      }
      if (source === 'all') {
        const [embedResult, embedCanaisResult, liveResult, xtreamResult] = await Promise.allSettled([
          getEmbedChannels(), getEmbedCanaisChannels(), getLiveChannels(), xtream.getCatalog()
        ]);
        if (embedResult.status === 'fulfilled') items.push(...embedResult.value);
        else failedSources.push('embedtv');
        if (embedCanaisResult.status === 'fulfilled') items.push(...embedCanaisResult.value);
        else failedSources.push('embedcanais');
        if (liveResult.status === 'fulfilled') items.push(...liveResult.value);
        else failedSources.push('live-tv');
        if (xtreamResult.status === 'fulfilled') {
          items.push(...xtreamResult.value.items);
          failedSources.push(...xtreamResult.value.failedSources);
          failedSourceDetails.push(...(xtreamResult.value.failedSourceDetails || []));
          sourceStatus = xtreamResult.value.sources;
          xtreamConfigured = xtreamResult.value.configured;
        } else failedSources.push('xtream');
      }
      const q = String(req.query.search || '').trim().toLowerCase();
      const category = String(req.query.category || '').trim().toLowerCase();
      if (q) items = items.filter((x) => `${x.name || x.title || ''} ${(x.categories || []).join(' ')} ${(x.categoryNames || []).join(' ')}`.toLowerCase().includes(q));
      if (category) items = items.filter((x) => [...(x.categories || []), ...(x.categoryNames || []), x.categoryName || ''].some((name) => String(name).toLowerCase().includes(category)));
      const unique = new Map();
      for (const item of items) unique.set(String(item.id || `${item.sourceId || item.source || ''}:${item.name || item.title || ''}`), item);
      items = [...unique.values()];
      const limit = clampInt(req.query.limit, 200, 1, 500); const offset = clampInt(req.query.offset, 0, 1000000);
      res.json({ items: items.slice(offset, offset + limit), total: items.length, offset, limit, xtreamConfigured, sources: sourceStatus, failedSources: [...new Set(failedSources)], failedSourceDetails, partial: failedSources.length > 0 });
    } catch { res.status(502).json({ error: 'API de TV ao vivo indisponível', requestId: req.requestId }); }
  });
  app.get('/api/v1/channels/:id', async (req, res) => { try { const loader = String(req.params.id).startsWith('embedcanais-') ? getEmbedCanaisChannels : getEmbedChannels; const item = (await loader()).find((x) => x.id === req.params.id); return item ? res.json(item) : res.status(404).json({ error: 'Canal não encontrado', requestId: req.requestId }); } catch { return res.status(502).json({ error: 'Catálogo de canais indisponível', requestId: req.requestId }); } });
  app.get('/api/v1/sports', async (_req, res) => { try { res.json({ items: arrayPayload(await cached('sports', () => upstream(liveBase, '/sports')), ['sports', 'events', 'items']) }); } catch { res.status(502).json({ error: 'Eventos esportivos indisponíveis' }); } });
  app.get('/api/v1/embedtv/events', async (_req, res) => { try { res.json({ items: arrayPayload(await embed('/api/events'), ['events', 'items', 'data']) }); } catch { res.status(502).json({ error: 'Eventos EmbedTV indisponíveis' }); } });
  app.get('/api/v1/embedtv/epg', async (_req, res) => { try { res.json({ items: arrayPayload(await embed('/api/epg_all'), ['channels', 'data', 'items']) }); } catch { res.status(502).json({ error: 'EPG EmbedTV indisponível' }); } });
  app.get('/api/v1/epg', async (req, res) => { try { const epg = await loadEpg(String(req.query.refresh || '') === '1'); const id = String(req.query.channelId || ''); res.json({ ...epg, channels: id ? epg.channels.filter((x) => x.id === id) : epg.channels, programmes: id ? epg.programmes.filter((x) => x.channel === id) : epg.programmes }); } catch { res.status(502).json({ error: 'Não foi possível carregar o EPG', channels: [], programmes: [] }); } });
  app.get('/api/v1/live-tv/health', (_req, res) => res.json({ ok: true, staticChannels: staticChannels.length, categories: staticCategories.length, epgConfigured: epgSources.length > 0, liveTvConfigured: true, embedTvConfigured: true, embedCanaisConfigured: true, xtreamConfigured: configuredXtreamSources.length > 0, xtreamSources: xtream.listSources().map((source) => source.id) }));
  app.use((_req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
  return app;
}

if (require.main === module) {
  const port = clampInt(readAppConfig().PORT, 7000, 1, 65535);
  createApp().listen(port, '0.0.0.0', () => console.log(`[tv-api] listening on ${port}`));
}
module.exports = { createApp, readChannelData, readAppConfig, loadEpgSources, parseEpgXml, xmltvTime, mapStaticChannel };
