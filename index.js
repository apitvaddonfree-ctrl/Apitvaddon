'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { XMLParser } = require('fast-xml-parser');
const { configureHttp, clampInt, safeHttpUrl } = require('./http.cjs');

const CHANNELS_DEFAULT = path.join(__dirname, 'data', 'embedTV.json');
const XML_PARSER = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', parseTagValue: false, trimValues: true });

function readChannelData(filename = CHANNELS_DEFAULT) {
  const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!Array.isArray(parsed.channels)) throw new Error('O catálogo de canais precisa conter channels[].');
  return parsed;
}

function loadEpgSources(env = process.env) {
  let sources = [];
  const raw = String(env.EPG_SOURCES_JSON || '[]');
  try { sources = JSON.parse(raw); } catch { throw new Error('EPG_SOURCES_JSON deve conter um array JSON válido.'); }
  if (!Array.isArray(sources) || sources.length > 10) throw new Error('EPG_SOURCES_JSON deve ter no máximo 10 fontes.');
  return sources.map((entry, index) => {
    const urlValue = typeof entry === 'string' ? entry : entry?.url;
    const url = safeHttpUrl(urlValue, `fonte EPG ${index + 1}`);
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
  const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const offset = sign ? (Number(offH) * 60 + Number(offM)) * 60_000 * (sign === '+' ? 1 : -1) : 0;
  return new Date(local - offset).toISOString();
}

function parseEpgXml(xml, sourceId) {
  const parsed = XML_PARSER.parse(xml);
  const root = parsed?.tv || {};
  const channels = asArray(root.channel).map((channel) => ({
    id: String(channel?.['@_id'] || '').slice(0, 200),
    name: textValue(channel?.['display-name']) || String(channel?.['@_id'] || '').slice(0, 200),
    sourceId
  })).filter((channel) => channel.id);
  const programmes = asArray(root.programme).map((programme) => ({
    channel: String(programme?.['@_channel'] || '').slice(0, 200),
    start: xmltvTime(programme?.['@_start']),
    stop: xmltvTime(programme?.['@_stop']),
    title: textValue(programme?.title).slice(0, 300),
    description: textValue(programme?.desc).slice(0, 3000),
    category: textValue(programme?.category).slice(0, 120),
    sourceId
  })).filter((item) => item.channel && item.start && item.title);
  return { channels, programmes };
}

function mapStaticChannel(channel) {
  let sourceUrl = '';
  try {
    const parsed = safeHttpUrl(channel.url, 'URL do canal');
    sourceUrl = parsed.toString();
  } catch { /* entradas sem URL válida permanecem visíveis, mas sem destino */ }
  return {
    id: String(channel.id || ''),
    name: String(channel.name || '').slice(0, 200),
    image: String(channel.image || '').slice(0, 2000),
    preview: String(channel.preview || '').slice(0, 2000),
    categories: Array.isArray(channel.categories) ? channel.categories : [],
    categoryNames: Array.isArray(channel.categoryNames) ? channel.categoryNames.map(String) : [],
    source: 'embedtv',
    sourceUrl,
    playbackMode: 'external-page'
  };
}

function createApp({ env = process.env, fetchImpl = globalThis.fetch, channelsFile = env.TV_CHANNELS_FILE || CHANNELS_DEFAULT } = {}) {
  const app = express();
  const channelData = readChannelData(channelsFile);
  const staticChannels = channelData.channels.map(mapStaticChannel).filter((channel) => channel.id);
  const staticCategories = Array.isArray(channelData.categories) ? channelData.categories : [];
  const epgSources = loadEpgSources(env);
  const xtreamBase = env.XTREAM_API_BASE_URL ? safeHttpUrl(env.XTREAM_API_BASE_URL, 'XTREAM_API_BASE_URL').toString().replace(/\/+$/, '') : '';
  const xtreamKey = String(env.XTREAM_API_KEY || '');
  const timeoutMs = clampInt(env.UPSTREAM_TIMEOUT_MS, 10_000, 1_000, 20_000);
  const epgCacheMs = clampInt(env.EPG_CACHE_MS, 300_000, 0, 3_600_000);
  let epgCache = null;
  let epgInFlight = null;
  let xtreamCache = null;

  configureHttp(app, 'iracemaflix-tv-api', env, { rateLimit: 60 });
  app.use('/api/v1', express.json({ limit: '16kb', strict: true }));
  app.get('/openapi.json', (_req, res) => res.type('application/json').sendFile(path.join(__dirname, 'openapi.json')));

  async function fetchWithTimeout(url, options = {}, consume = async (response) => response) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      return await consume(response);
    }
    finally { clearTimeout(timer); }
  }

  async function fetchXtreamLive(force = false) {
    if (!xtreamBase) throw Object.assign(new Error('Integração Xtream não configurada.'), { status: 503 });
    if (!force && xtreamCache && xtreamCache.expiresAt > Date.now()) return xtreamCache.items;
    const url = new URL('/api/v1/catalog/live?limit=500', `${xtreamBase}/`);
    const headers = { Accept: 'application/json' };
    if (xtreamKey) headers.Authorization = `Bearer ${xtreamKey}`;
    const body = await fetchWithTimeout(url, { headers }, async (response) => {
      if (!response.ok) throw new Error('API Xtream indisponível');
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > 10 * 1024 * 1024) throw new Error('Resposta da API Xtream muito grande');
      try { return JSON.parse(text); } catch { throw new Error('Resposta inválida da API Xtream'); }
    });
    if (!Array.isArray(body?.items)) throw new Error('Resposta inválida da API Xtream');
    const items = body.items.map((item) => ({
      id: `xtream:${String(item.sourceId || 'source')}:${String(item.id || '')}`,
      name: String(item.name || '').slice(0, 200),
      image: String(item.image || '').slice(0, 2000),
      categoryId: String(item.categoryId || ''),
      source: 'xtream',
      sourceId: String(item.sourceId || ''),
      playbackPath: item.playbackPath ? new URL(String(item.playbackPath), `${xtreamBase}/`).toString() : '',
      playbackMode: 'xtream-redirect'
    })).filter((item) => item.name && item.id);
    xtreamCache = { items, expiresAt: Date.now() + 30_000 };
    return items;
  }

  async function fetchEpg(force = false) {
    if (!epgSources.length) return { configured: false, channels: [], programmes: [], failedSources: [] };
    if (!force && epgCache && epgCache.expiresAt > Date.now()) return epgCache.value;
    if (epgInFlight) return epgInFlight;
    epgInFlight = (async () => {
      const outcomes = await Promise.all(epgSources.map(async (source) => {
        try {
          const data = await fetchWithTimeout(source.url, { headers: { Accept: 'application/xml,text/xml,*/*' } }, async (response) => {
            if (!response.ok) throw new Error('upstream');
            const contentLength = Number(response.headers.get('content-length') || 0);
            if (contentLength > 25 * 1024 * 1024) throw new Error('payload grande');
            const xml = await response.text();
            if (Buffer.byteLength(xml, 'utf8') > 25 * 1024 * 1024) throw new Error('payload grande');
            return parseEpgXml(xml, source.id);
          });
          return { id: source.id, data };
        } catch { return { id: source.id, failed: true }; }
      }));
      const failedSources = outcomes.filter((item) => item.failed).map((item) => item.id);
      const successful = outcomes.filter((item) => item.data);
      const channels = successful.flatMap((item) => item.data.channels);
      const seen = new Set();
      const programmes = successful.flatMap((item) => item.data.programmes).filter((item) => {
        const key = `${item.channel}|${item.start}|${item.title}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const value = { configured: true, channels, programmes, failedSources };
      if (epgCacheMs > 0 && successful.length) epgCache = { value, expiresAt: Date.now() + epgCacheMs };
      return value;
    })();
    try { return await epgInFlight; } finally { epgInFlight = null; }
  }

  app.get('/api/v1/categories', (_req, res) => res.json({ categories: staticCategories }));

  app.get('/api/v1/channels', async (req, res) => {
    const source = String(req.query.source || 'all').toLowerCase();
    if (!['all', 'embedtv', 'xtream'].includes(source)) return res.status(400).json({ error: 'source deve ser all, embedtv ou xtream', requestId: req.requestId });
    const search = String(req.query.search || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const category = String(req.query.categoryId || '');
    const staticItems = source === 'xtream' ? [] : staticChannels.filter((item) => {
      const matchesSearch = !search || item.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(search);
      const matchesCategory = !category || item.categories.some((value) => String(value) === category);
      return matchesSearch && matchesCategory;
    });
    let xtreamItems = [];
    let xtreamError = '';
    if (source === 'xtream' || (source === 'all' && xtreamBase)) {
      try { xtreamItems = (await fetchXtreamLive()).filter((item) => !search || item.name.toLowerCase().includes(search)); }
      catch (error) {
        xtreamError = error.status === 503 ? error.message : 'API Xtream indisponível';
        if (source === 'xtream') return res.status(error.status || 502).json({ error: xtreamError, requestId: req.requestId });
      }
    }
    const items = [...staticItems, ...xtreamItems];
    const limit = clampInt(req.query.limit, 200, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, 1_000_000);
    res.json({ items: items.slice(offset, offset + limit), total: items.length, offset, limit, partial: Boolean(xtreamError), ...(xtreamError ? { warnings: [xtreamError] } : {}) });
  });

  app.get('/api/v1/channels/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (id.startsWith('xtream:')) {
      try {
        const item = (await fetchXtreamLive()).find((channel) => channel.id === id);
        return item ? res.json(item) : res.status(404).json({ error: 'Canal não encontrado', requestId: req.requestId });
      } catch (error) { return res.status(error.status || 502).json({ error: error.status === 503 ? error.message : 'API Xtream indisponível', requestId: req.requestId }); }
    }
    const item = staticChannels.find((channel) => channel.id === id);
    if (!item) return res.status(404).json({ error: 'Canal não encontrado', requestId: req.requestId });
    res.json(item);
  });

  app.get('/api/v1/epg', async (req, res) => {
    try {
      const epg = await fetchEpg(String(req.query.refresh || '') === '1');
      const channelId = String(req.query.channelId || '');
      const limit = clampInt(req.query.limit, 200, 1, 500);
      const channels = channelId ? epg.channels.filter((item) => item.id === channelId) : epg.channels;
      const programmes = epg.programmes.filter((item) => !channelId || item.channel === channelId)
        .sort((a, b) => a.start.localeCompare(b.start)).slice(0, limit);
      res.json({ configured: epg.configured, channels, programmes, failedSources: epg.failedSources });
    } catch { res.status(502).json({ error: 'Não foi possível carregar o EPG', channels: [], programmes: [], requestId: req.requestId }); }
  });

  app.get('/api/v1/live-tv/health', (_req, res) => res.json({
    ok: true,
    staticChannels: staticChannels.length,
    categories: staticCategories.length,
    epgConfigured: epgSources.length > 0,
    xtreamConfigured: Boolean(xtreamBase)
  }));

  app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada', requestId: req.requestId }));
  app.use((err, req, res, _next) => {
    if (res.headersSent) return res.end();
    const candidate = Number(err?.statusCode || err?.status);
    const status = candidate >= 400 && candidate < 600 ? candidate : 500;
    res.status(status).json({ error: status === 500 ? 'Erro interno do serviço' : String(err.message || 'Falha na requisição'), requestId: req?.requestId });
  });
  return app;
}

if (require.main === module) {
  const port = clampInt(process.env.PORT, 8080, 1, 65_535);
  const app = createApp();
  app.listen(port, '0.0.0.0', () => console.log(`[tv-api] listening on ${port}`));
}

module.exports = { createApp, readChannelData, loadEpgSources, parseEpgXml, xmltvTime, mapStaticChannel };
