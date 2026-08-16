import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8080,
  dataDir: './data',
  storagePath: './data/files',
  dbPath: './data/webdrop.sqlite',
  adminUsername: 'admin',
  adminPassword: 'admin',
  defaultQuotaGb: 100,
  maxUploadBytes: 10 * 1024 ** 3,
  heartbeatIntervalMs: 30000,
  heartbeatTimeoutMs: 120000,
  stagingThresholdBytes: 10 * 1024 ** 2,
  jobIntervalMs: 60000,
  tempUserInactiveDays: 30,
};

function envKey(key) {
  return `WEBDROP_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

export function loadConfig(rootDir = process.cwd()) {
  const cfgPath = path.join(rootDir, 'config', 'config.json');
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    // 使用默认配置
  }
  const cfg = { ...DEFAULTS, ...file, rootDir };
  for (const key of Object.keys(DEFAULTS)) {
    const env = process.env[envKey(key)];
    if (env !== undefined) {
      if (typeof DEFAULTS[key] === 'number') cfg[key] = Number(env);
      else if (typeof DEFAULTS[key] === 'boolean') cfg[key] = env === 'true' || env === '1';
      else cfg[key] = env;
    }
  }
  cfg.dataDir = path.resolve(rootDir, cfg.dataDir);
  cfg.dbPath = path.resolve(rootDir, cfg.dbPath);
  cfg.storagePath = path.resolve(rootDir, cfg.storagePath);
  return cfg;
}

export function resolvePath(rootDir, p) {
  if (path.isAbsolute(p)) return p;
  return path.resolve(rootDir, p);
}
