'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeHttpUrl, clampInt } = require('./http.cjs');

const MAX_SOURCES = 50;
const DEFAULT_SOURCE_TIMEOUT_MS = 8000;

function normalizeXtreamSource(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Fonte Xtream ${index + 1} inválida.`);
  const id = String(raw.id || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`ID da fonte Xtream ${index + 1} inválido.`);
  if (raw.enabled === false) return null;

  let base;
  let playlistUrl = null;
  try {
    if (raw.base) base = safeHttpUrl(raw.base, `base da fonte Xtream ${id}`);
    else if (raw.url) {
      playlistUrl = safeHttpUrl(raw.url, `URL da fonte Xtream ${id}`);
      base = new URL(playlistUrl.origin);
      base.pathname = playlistUrl.pathname;
    } else throw new Error('base ou url ausente');
  } catch { throw new Error(`Base HTTP(S) ou URL M3U inválida para a fonte Xtream ${id}.`); }
  if (base.username || base.password || base.search || base.hash) throw new Error(`A base da fonte Xtream ${id} não pode conter credenciais, query ou fragmento.`);
  if (/\/(?:player_api\.php|get\.php|playlist(?:\.[a-z0-9]+)?|m3u(?:_plus)?\.php)\/?$/i.test(base.pathname)) {
    base.pathname = base.pathname.replace(/\/(?:player_api\.php|get\.php|playlist(?:\.[a-z0-9]+)?|m3u(?:_plus)?\.php)\/?$/i, '');
  }
  base.pathname = base.pathname.replace(/\/+$/, '');

  const username = String(raw.username || playlistUrl?.searchParams.get('username') || '').trim();
  const password = String(raw.password || playlistUrl?.searchParams.get('password') || '').trim();
  if (!username || !password) throw new Error(`Usuário e senha ausentes para a fonte Xtream ${id}.`);

  return {
    id,
    name: String(raw.name || raw.sourceName || id).trim().slice(0, 120) || id,
    base: base.toString().replace(/\/$/, ''),
    username,
    password,
    userAgent: String(raw.userAgent || 'Mozilla/5.0').slice(0, 300),
    timeoutMs: clampInt(raw.timeoutMs, DEFAULT_SOURCE_TIMEOUT_MS, 1000, 120000)
  };
}

function orderXtreamSources(sources, priority = []) {
  const priorityIndex = new Map((Array.isArray(priority) ? priority : []).map((id, index) => [String(id).toLowerCase(), index]));
  return [...sources].sort((a, b) => {
    const ai = priorityIndex.has(a.id.toLowerCase()) ? priorityIndex.get(a.id.toLowerCase()) : Number.MAX_SAFE_INTEGER;
    const bi = priorityIndex.has(b.id.toLowerCase()) ? priorityIndex.get(b.id.toLowerCase()) : Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

function hasXtreamCredentials(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (String(entry.username || '').trim() && String(entry.password || '').trim()) return true;
  try {
    const url = safeHttpUrl(entry.url, 'URL da fonte Xtream');
    return Boolean(url.searchParams.get('username') && url.searchParams.get('password'));
  } catch { return false; }
}

function credentialsMapFromEnv(env) {
  const text = String(env.XTREAM_CREDENTIALS_JSON || '').trim();
  if (!text) return new Map();
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error('XTREAM_CREDENTIALS_JSON precisa conter JSON válido.'); }
  const entries = Array.isArray(payload)
    ? payload.map((item) => [item?.id, item])
    : payload && typeof payload === 'object' ? Object.entries(payload) : null;
  if (!entries) throw new Error('XTREAM_CREDENTIALS_JSON precisa ser um objeto indexado por ID ou uma lista.');
  const result = new Map();
  for (const [key, value] of entries) {
    const id = String(value?.id || key || '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !value || typeof value !== 'object') continue;
    const username = String(value.username || '').trim();
    const password = String(value.password || '').trim();
    if (username && password) result.set(id.toLowerCase(), { username, password });
  }
  return result;
}

function applyXtreamCredentials(entries, credentials) {
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const pair = credentials.get(String(entry.id || '').toLowerCase()) || {};
    return {
      ...entry,
      username: entry.username || pair.username || '',
      password: entry.password || pair.password || ''
    };
  });
}

function loadXtreamSources({ env = process.env, appConfig = {}, sourcesFile = null } = {}) {
  let raw = null;
  const credentials = credentialsMapFromEnv(env);
  const envSources = String(env.XTREAM_SOURCES_JSON || env.M3U_SOURCES_JSON || '').trim();
  if (envSources) {
    try { raw = JSON.parse(envSources); }
    catch { throw new Error('XTREAM_SOURCES_JSON ou M3U_SOURCES_JSON precisa conter JSON válido.'); }
  } else if (Array.isArray(appConfig.XTREAM_SOURCES)) {
    raw = appConfig.XTREAM_SOURCES;
  } else {
    const m3uSources = Array.isArray(appConfig.M3U_SOURCES) ? applyXtreamCredentials(appConfig.M3U_SOURCES, credentials) : [];
    if (m3uSources.some(hasXtreamCredentials)) raw = m3uSources;
    else {
      const configuredFile = sourcesFile || appConfig.XTREAM_SOURCES_FILE;
      if (configuredFile) {
        const resolved = path.isAbsolute(String(configuredFile)) ? String(configuredFile) : path.resolve(__dirname, String(configuredFile));
        if (fs.existsSync(resolved)) {
          try { raw = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
          catch { throw new Error('O arquivo de fontes Xtream não contém JSON válido.'); }
        }
      }
    }
  }
  if (raw == null) raw = [];
  if (!Array.isArray(raw)) throw new Error('A configuração Xtream precisa ser uma lista JSON.');
  if (raw.length > MAX_SOURCES) throw new Error(`O limite é de ${MAX_SOURCES} fontes Xtream.`);
  const seen = new Set();
  const sources = applyXtreamCredentials(raw, credentials).filter(hasXtreamCredentials).map(normalizeXtreamSource).filter(Boolean);
  for (const source of sources) {
    const key = source.id.toLowerCase();
    if (seen.has(key)) throw new Error(`ID Xtream duplicado: ${source.id}.`);
    seen.add(key);
  }
  return orderXtreamSources(sources, appConfig.XTREAM_SEARCH_PRIORITY);
}

function publicSource(source) {
  return { id: source.id, name: source.name };
}

function cleanExtension(value) {
  const extension = String(value || 'ts').replace(/^\./, '').toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : 'ts';
}

function createXtreamClient({ fetchImpl = globalThis.fetch, sources = [], cacheMs = 300000, concurrency = 4 } = {}) {
  const cache = new Map();
  const maxConcurrent = clampInt(concurrency, 12, 1, 20);
  const ttlMs = clampInt(cacheMs, 300000, 0, 3600000);

  async function request(source, action) {
    const url = new URL(`${source.base}/player_api.php`);
    url.searchParams.set('username', source.username);
    url.searchParams.set('password', source.password);
    url.searchParams.set('action', action);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), source.timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': source.userAgent },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
      const text = await response.text();
      let payload;
      try { payload = JSON.parse(text); }
      catch { throw new Error('resposta Xtream não é JSON'); }
      return payload;
    } finally { clearTimeout(timer); }
  }

  async function loadSource(source) {
    const [categoriesResult, streamsResult] = await Promise.allSettled([
      request(source, 'get_live_categories'),
      request(source, 'get_live_streams')
    ]);
    if (streamsResult.status === 'rejected') throw streamsResult.reason;
    const rawStreams = streamsResult.value;
    if (!Array.isArray(rawStreams)) throw new Error('get_live_streams não retornou uma lista.');
    const rawCategories = categoriesResult.status === 'fulfilled' && Array.isArray(categoriesResult.value)
      ? categoriesResult.value : [];
    const categoryNames = new Map(rawCategories.map((item) => [String(item.category_id ?? item.categoryId ?? ''), String(item.category_name || item.categoryName || item.name || '')]));
    const items = rawStreams.map((item) => {
      const streamId = String(item?.stream_id ?? item?.streamId ?? item?.id ?? '').trim();
      const name = String(item?.name || item?.title || '').trim().slice(0, 250);
      if (!streamId || !name) return null;
      const categoryId = String(item.category_id ?? item.categoryId ?? '').trim();
      const categoryName = String(item.category_name || item.categoryName || categoryNames.get(categoryId) || '').trim();
      const categories = categoryName ? [categoryName] : [];
      const image = String(item.stream_icon || item.cover || item.logo || item.channel_logo || '').slice(0, 2000);
      return {
        id: `xtream-${source.id}-${streamId}`,
        name,
        ...(image ? { image } : {}),
        categories,
        categoryNames: categories,
        source: 'xtream',
        sourceId: source.id,
        sourceName: source.name,
        streamId,
        ...(categoryId ? { categoryId } : {}),
        ...(categoryName ? { categoryName } : {}),
        streamType: 'live',
        extension: cleanExtension(item.container_extension || item.extension),
        playbackMode: 'xtream'
      };
    }).filter(Boolean);
    const categoryCounts = new Map();
    for (const item of items) {
      if (item.categoryId) categoryCounts.set(item.categoryId, (categoryCounts.get(item.categoryId) || 0) + 1);
    }
    const categories = rawCategories.map((item) => {
      const categoryId = String(item.category_id ?? item.categoryId ?? '').trim();
      const name = String(item.category_name || item.categoryName || item.name || '').trim();
      if (!categoryId || !name) return null;
      return {
        id: `xtream-${source.id}-${categoryId}`,
        categoryId,
        name,
        source: 'xtream',
        sourceId: source.id,
        sourceName: source.name,
        count: categoryCounts.get(categoryId) || 0
      };
    }).filter(Boolean);
    return { source: publicSource(source), items, categories };
  }

  async function getSource(source, force = false) {
    const hit = cache.get(source.id);
    if (!force && hit?.expiresAt > Date.now()) return hit.value;
    if (!force && hit?.pending) return hit.pending;
    const pending = loadSource(source).then((value) => {
      cache.set(source.id, { value, expiresAt: Date.now() + ttlMs });
      return value;
    }).catch((error) => {
      cache.delete(source.id);
      throw error;
    });
    cache.set(source.id, { pending, expiresAt: 0 });
    return pending;
  }

  async function getCatalog({ sourceId = '', force = false } = {}) {
    const chosen = sourceId ? sources.filter((source) => source.id === sourceId) : sources;
    if (sourceId && !chosen.length) return { configured: sources.length > 0, items: [], categories: [], sources: [], failedSources: [sourceId], unknownSource: true };
    if (!chosen.length) return { configured: false, items: [], categories: [], sources: [], failedSources: [] };

    const results = new Array(chosen.length);
    let cursor = 0;
    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= chosen.length) return;
        const source = chosen[index];
        try { results[index] = await getSource(source, force); }
        catch { results[index] = { source: publicSource(source), items: [], failed: true }; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(maxConcurrent, chosen.length) }, worker));
    const successful = results.filter((result) => !result.failed);
    const failedSources = results.filter((result) => result.failed).map((result) => result.source.id);
    const items = results.flatMap((result) => result.items || []);
    return {
      configured: true,
      items,
      categories: results.flatMap((result) => result.categories || []),
      sources: successful.map((result) => ({ ...result.source, count: result.items.length })),
      failedSources,
      partial: failedSources.length > 0
    };
  }

  function listSources() { return sources.map(publicSource); }
  return { getCatalog, listSources };
}

module.exports = { createXtreamClient, loadXtreamSources, normalizeXtreamSource, orderXtreamSources };
