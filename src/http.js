import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
};

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    if (typeof pattern === 'string') {
      const src = pattern.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, (m) => `(?<${m.slice(1)}>[^/]+)`);
      pattern = new RegExp(`^${src}$`);
    }
    this.routes.push({ method, pattern, handler });
  }

  get(pattern, handler) {
    this.add('GET', pattern, handler);
  }

  post(pattern, handler) {
    this.add('POST', pattern, handler);
  }

  put(pattern, handler) {
    this.add('PUT', pattern, handler);
  }

  delete(pattern, handler) {
    this.add('DELETE', pattern, handler);
  }

  async match(req, res, ctx) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(p);
      if (m) {
        const groups = m.groups || {};
        req.params = {};
        for (const [k, v] of Object.entries(groups)) {
          try {
            req.params[k] = decodeURIComponent(v);
          } catch {
            req.params[k] = v;
          }
        }
        req.query = url.searchParams;
        try {
          await r.handler(req, res, ctx);
        } catch (e) {
          sendError(res, e);
        }
        return true;
      }
    }
    return false;
  }
}

export function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export async function readJson(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const e = new Error('请求体过大');
      e.statusCode = 413;
      throw e;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    const e = new Error('无效的 JSON');
    e.statusCode = 400;
    throw e;
  }
}

export function decodeHeader(v) {
  try {
    return decodeURIComponent(v || '');
  } catch {
    return String(v || '');
  }
}

export function sendError(res, err) {
  const code = err.statusCode || 500;
  sendJson(res, code, { error: err.message || '服务器错误' });
}

export function serveStatic(res, rootDir, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  let rel = clean === '/' ? '/index.html' : clean;
  let file = path.resolve(rootDir, '.' + rel);
  if (!file.startsWith(path.resolve(rootDir))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, 'index.html');
  }
  if (!fs.existsSync(file)) {
    // SPA fallback
    file = path.join(rootDir, 'index.html');
  }
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  const st = fs.statSync(file);
  if (ext !== '.html') headers['Cache-Control'] = 'no-cache';
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  fs.createReadStream(file).pipe(res);
}

export function token() {
  return randomBytes(32).toString('hex');
}

export function nowIso() {
  return new Date().toISOString();
}
