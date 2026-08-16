#!/usr/bin/env node
// 重置唯一管理员账号密码：node scripts/reset-admin.js [新用户名] [新密码]
// 无参数时重置为默认 admin:admin
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { hashPassword } from '../src/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const cfg = loadConfig(ROOT);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const db = openDb(cfg.dbPath, cfg);
  const admin = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!admin) {
    console.error('未找到管理员账号（服务尚未初始化？）');
    process.exit(1);
  }
  const username = (process.argv[2] || cfg.adminUsername || 'admin').trim();
  const password = process.argv[3] || cfg.adminPassword || 'admin';
  if (!username || !password) {
    console.error('用户名和密码不能为空');
    process.exit(1);
  }
  const conflict = db
    .prepare('SELECT 1 FROM users WHERE username = ? AND id != ?')
    .get(username, admin.id);
  if (conflict) {
    console.error('该用户名已被其他账号占用');
    process.exit(1);
  }
  const hash = await hashPassword(password);
  db.prepare(
    'UPDATE users SET username = ?, password_hash = ?, must_change = 0 WHERE id = ?'
  ).run(username, hash, admin.id);
  db.prepare('DELETE FROM tokens WHERE user_id = ?').run(admin.id);
  console.log(`管理员账号已重置：${username} / ${password}`);
  console.log('所有旧会话已失效，请重新登录。');
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
