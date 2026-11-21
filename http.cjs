'use strict';

const crypto = require('node:crypto');

function assertProductionKey(env = process.env) {
  if (env.NODE_ENV === 'production' && String(env.API_KEY || '').length < 32) {
    throw new Error('API_KEY deve ter pelo menos 32 caracteres em produção.');
  }
}

function configureHttp(app, service, env = process.env, options = {}) {
  assertProductionKey(env);
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY === '1' ? 1 : false);
  const allowedOrigins = String(env.CORS_ALLOW_ORIGINS || '')
    .split(',').map((item) => item.trim()).filter(Boolean);
  const limits = new Map();
  const perMinute = Math.max(10, Number(options.rateLimit || env.RATE_LIMIT_PER_MINUTE || 60) || 60);

  app.use((req, res, next) => {
    const incoming = String(req.get('x-request-id') || '').trim();
    const requestId = /^[A-Za-z0-9._-]{1,80}$/.test(incoming) ? incoming : crypto.randomUUID();
    req.requestId = requestId;
    res.set('X-Request-ID', requestId);
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
      res.set('Access-Control-Allow-Origin', allowedOrigins.includes('*') ? '*' : origin);
      res.vary('Origin');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-ID');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, service, version: '1.0.0' }));
  app.use('/api/v1', (req, res, next) => {
    const configured = String(env.API_KEY || '');
    if (!configured && env.NODE_ENV !== 'production') return next();
    const supplied = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(configured);
    const b = Buffer.from(supplied);
    if (!configured || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Não autorizado', requestId: req.requestId });
    }
    const now = Date.now();
    const client = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const recent = (limits.get(client) || []).filter((timestamp) => now - timestamp < 60_000);
    if (recent.length >= perMinute) return res.status(429).json({ error: 'Limite de consultas por minuto excedido', requestId: req.requestId });
    recent.push(now);
    limits.set(client, recent);
    if (limits.size > 5000) {
      for (const [key, timestamps] of limits) {
        if (!timestamps.some((timestamp) => now - timestamp < 60_000)) limits.delete(key);
      }
    }
    next();
  });
  app.use((err, req, res, _next) => {
    const candidate = Number(err?.statusCode || err?.status);
    const status = candidate >= 400 && candidate < 600 ? candidate : 500;
    if (res.headersSent) return res.end();
    res.status(status).json({ error: status === 500 ? 'Erro interno do serviço' : String(err.message || 'Falha na requisição'), requestId: req?.requestId });
  });
}

function clampInt(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

module.exports = { assertProductionKey, configureHttp, clampInt };
