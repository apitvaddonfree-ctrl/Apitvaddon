'use strict';

const crypto = require('node:crypto');
function configureHttp(app, service, options = {}) {
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const limits = new Map();
  const perMinute = Math.max(10, Number(options.rateLimit || 60) || 60);
  app.use((req, res, next) => {
    req.requestId = /^[A-Za-z0-9._-]{1,80}$/.test(String(req.get('x-request-id') || '')) ? req.get('x-request-id') : crypto.randomUUID();
    res.set('X-Request-ID', req.requestId); res.set('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true, service, version: '1.1.0' }));
  app.use('/api/v1', (req, res, next) => {
    const now = Date.now(); const client = String(req.socket?.remoteAddress || 'unknown');
    const recent = (limits.get(client) || []).filter((t) => now - t < 60000);
    if (recent.length >= perMinute) return res.status(429).json({ error: 'Limite de consultas por minuto excedido', requestId: req.requestId });
    recent.push(now); limits.set(client, recent); next();
  });
}
function clampInt(value, fallback, minimum, maximum) { const parsed = Number.parseInt(String(value ?? ''), 10); return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback; }
function safeHttpUrl(value, label = 'URL') { let url; try { url = new URL(String(value)); } catch { throw new Error(`${label} inválida.`); } if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label} deve usar HTTP(S).`); return url; }
module.exports = { configureHttp, clampInt, safeHttpUrl };
