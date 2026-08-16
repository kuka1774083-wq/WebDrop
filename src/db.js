import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, nowIso } from './util.js';

export function openDb(dbPath, { storagePath, dataDir }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL DEFAULT 'temp',
      username TEXT UNIQUE,
      uuid TEXT,
      nickname TEXT,
      email TEXT,
      qq TEXT,
      password_hash TEXT,
      level INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'normal',
      quota_bytes INTEGER NOT NULL DEFAULT 0,
      used_bytes INTEGER NOT NULL DEFAULT 0,
      must_change INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      nickname TEXT,
      email TEXT,
      qq TEXT,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_a INTEGER NOT NULL,
      user_b INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      relay_mode INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_number TEXT NOT NULL UNIQUE,
      owner_id INTEGER NOT NULL,
      title TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      destroy_at TEXT,
      created_at TEXT NOT NULL,
      destroyed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS room_number_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      requested_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS rooms_users (
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (room_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS room_blacklist (
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (room_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime TEXT,
      kind TEXT NOT NULL DEFAULT 'file',
      path TEXT,
      thumb_path TEXT,
      preview_path TEXT,
      access_token TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      delete_reason TEXT,
      expires_at TEXT,
      ready INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_files_ref ON files(ref_id);
    CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id);
    CREATE TABLE IF NOT EXISTS room_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_room_folders_room ON room_folders(room_id);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      sender_id INTEGER NOT NULL,
      sender_name TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT,
      file_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_ref ON messages(ref_id, id);
    CREATE TABLE IF NOT EXISTS tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_devices (
      user_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT DEFAULT '',
      browser TEXT DEFAULT '',
      model TEXT DEFAULT '',
      last_seen_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'normal',
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // 迁移：兼容已有数据库
  const addColumn = (table, column, ddl) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    } catch {
      // 列已存在
    }
  };
  addColumn('rooms', 'password_hash', 'password_hash TEXT');
  addColumn('rooms', 'max_retention_days', 'max_retention_days INTEGER');
  addColumn('rooms', 'max_file_size', 'max_file_size INTEGER NOT NULL DEFAULT 10737418240');
  addColumn('rooms', 'room_capacity_bytes', 'room_capacity_bytes INTEGER');
  addColumn('rooms', 'upload_permission', "upload_permission TEXT DEFAULT 'all'");
  addColumn('rooms', 'download_permission', "download_permission TEXT DEFAULT 'all'");
  addColumn('rooms_users', 'left', 'left INTEGER NOT NULL DEFAULT 0');
  addColumn('files', 'folder_id', 'folder_id INTEGER');
  addColumn('messages', 'deleted', 'deleted INTEGER NOT NULL DEFAULT 0');
  addColumn('messages', 'client_id', 'client_id TEXT');
  addColumn('sessions', 'device_a', 'device_a TEXT');
  addColumn('sessions', 'device_b', 'device_b TEXT');
  addColumn('tokens', 'device_id', 'device_id TEXT');
  addColumn('users', 'theme', 'theme TEXT DEFAULT NULL');
  return db;
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

/** 首次启动创建唯一管理员（默认 admin:admin） */
export async function bootstrapAdmin(db, cfg) {
  const admin = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get();
  if (admin) return admin;
  const username = cfg.adminUsername || 'admin';
  const password = cfg.adminPassword || 'admin';
  const hash = await hashPassword(password);
  const ts = nowIso();
  db.prepare(
    `INSERT INTO users (role, username, uuid, password_hash, level, status, quota_bytes, used_bytes, created_at, last_active_at)
     VALUES ('admin', ?, ?, ?, -1, 'normal', 0, 0, ?, ?)`
  ).run(username, randomUUID(), hash, ts, ts);
  return db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get();
}
