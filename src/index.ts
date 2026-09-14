import 'dotenv/config';
import http from 'node:http';
import { createEndpoint } from '@jambonz/sdk/websocket';
import { loadConfig } from './config.js';
import { createCalendar } from './calendar/index.js';
import { ContextStore } from './telephony/context-store.js';
import { attachAssistant } from './telephony/jambonz-app.js';
import { logger } from './logger.js';

const cfg = loadConfig();
const calendar = createCalendar(cfg);
const contextStore = new ContextStore();

/**
 * Small REST surface next to the jambonz WebSocket endpoint:
 *   GET /health           — liveness for load balancers
 *   GET /context/:token   — full transfer context; called by a Genesys
 *                           Architect data action after reading the token
 *                           from Call.UUIData. Guarded by CONTEXT_API_KEY.
 */
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, calendar: calendar.name }));
    return;
  }

  const contextMatch = url.pathname.match(/^\/context\/([0-9a-f-]{36})$/i);
  if (req.method === 'GET' && contextMatch) {
    if (cfg.server.contextApiKey && req.headers['x-api-key'] !== cfg.server.contextApiKey) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const context = contextStore.get(contextMatch[1]);
    if (!context) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown or expired token' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(context));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

const makeService = createEndpoint({ server });
const svc = makeService({ path: cfg.server.wsPath });
attachAssistant(svc, cfg, calendar, contextStore);

server.listen(cfg.server.port, () => {
  logger.info(
    `CEO assistant listening on :${cfg.server.port} ` +
      `(jambonz ws path: ${cfg.server.wsPath}, calendar: ${calendar.name}, ` +
      `genesys transfer: ${cfg.genesys.transferSipUri || 'NOT CONFIGURED'})`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
