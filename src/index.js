import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb, bootstrapAdmin } from './db.js';
import { Service } from './service.js';
import { Hub, WsServer } from './ws.js';
import { Router, sendJson, serveStatic } from './http.js';
import { authRoutes } from './auth.js';
import { roomRoutes } from './rooms.js';
import { fileRoutes } from './files.js';
import { adminRoutes } from './admin.js';
import { startJobs } from './jobs.js';
import { themeRoutes } from './themes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const cfg = loadConfig(ROOT);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const db = openDb(cfg.dbPath, cfg);
  await bootstrapAdmin(db, cfg);
  const service = new Service(db, cfg);
  const hub = new Hub();

  const api = new Router();
  api.get('/api/health', (req, res) => sendJson(res, 200, { ok: true }));

  const ctx = { db, cfg, service, hub };
  for (const router of [
    authRoutes(ctx),
    roomRoutes(ctx),
    fileRoutes(ctx),
    adminRoutes(ctx),
    themeRoutes(ctx),
  ]) {
    for (const route of router.routes) api.add(route.method, route.pattern, route.handler);
  }

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      api.match(req, res, ctx).then((matched) => {
        if (!matched) sendJson(res, 404, { error: 'Not Found' });
      });
      return;
    }
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/admin' || urlPath === '/admin/') {
      // 独立管理面板页（仅管理员登录、可多开）
      serveStatic(res, path.join(ROOT, 'public'), '/admin.html');
      return;
    }
    serveStatic(res, path.join(ROOT, 'public'), req.url);
  });

  const wss = new WsServer({ httpServer: server, db, cfg, service, hub });
  wss.startHeartbeat();

  service.onFileReady = (file) => {
    if (file.scope !== 'room') return;
    const room = db.prepare('SELECT room_number FROM rooms WHERE id = ?').get(file.ref_id);
    if (room) hub.emitRoom(room.room_number, { type: 'roomFileReady', file: service.publicFile(file) });
  };

  startJobs({ db, cfg, service, hub });

  server.listen(cfg.port, cfg.host, () => {
    console.log(`WebDrop 已启动: http://${cfg.host}:${cfg.port}`);
  });

  const shutdown = () => {
    console.log('正在关闭...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
