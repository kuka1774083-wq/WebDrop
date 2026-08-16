import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  randomId,
  nowIso,
  kindForMime,
  safeFilename,
  quotaBytesForLevel,
  genTempNickname,
} from './util.js';
import { getSetting } from './db.js';
import { makeImageThumb, makeVideoThumb, makeVideoPreview, toM4a, removeIfExists } from './media.js';

export class Service {
  constructor(db, cfg) {
    this.db = db;
    this.cfg = cfg;
    this.ensureDirs();
  }

  dirs() {
    const dataDir = this.cfg.dataDir;
    const filesDir = this.getStoragePath();
    return {
      dataDir,
      filesDir,
      stagingDir: path.join(dataDir, 'staging'),
      thumbsDir: path.join(dataDir, 'thumbs'),
      previewsDir: path.join(dataDir, 'previews'),
    };
  }

  ensureDirs() {
    for (const d of Object.values(this.dirs())) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  getStoragePath() {
    const sp = getSetting(this.db, 'storagePath', null);
    if (sp) {
      if (path.isAbsolute(sp)) return sp;
      return path.resolve(this.cfg.rootDir, sp);
    }
    return this.cfg.storagePath;
  }

  maxUploadBytes() {
    return Number(getSetting(this.db, 'maxUploadBytes', this.cfg.maxUploadBytes));
  }

  defaultQuotaGb() {
    return Number(getSetting(this.db, 'defaultQuotaGb', this.cfg.defaultQuotaGb));
  }

  quotaFor(user) {
    if (user.role === 'admin') return Infinity;
    if (user.role === 'temp') return quotaBytesForLevel(this.defaultQuotaGb(), 0);
    return quotaBytesForLevel(this.defaultQuotaGb(), user.level);
  }

  /** 根据请求识别用户：Bearer token 或 x-temp-id */
  identify(req) {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      const t = auth.slice(7);
      const row = this.tokenUser(t);
      if (row) return row;
    }
    const tempId = req.headers['x-temp-id'];
    if (tempId) {
      const u = this.tempUser(tempId);
      if (u) return u;
    }
    // 媒体元素（<video>/<audio>）无法设置请求头，支持 URL 查询参数携带会话凭证
    const qToken = req.query?.get?.('token');
    if (qToken) {
      const row = this.tokenUser(qToken);
      if (row) return row;
    }
    const qTemp = req.query?.get?.('temp');
    if (qTemp) {
      const u = this.tempUser(qTemp);
      if (u) return u;
    }
    return null;
  }

  tokenUser(t) {
    return (
      this.db
        .prepare(
          `SELECT u.* FROM tokens tk JOIN users u ON u.id = tk.user_id
           WHERE tk.token = ? AND tk.expires_at > ?`
        )
        .get(t, nowIso()) || null
    );
  }

  tempUser(uuid) {
    return (
      this.db
        .prepare("SELECT * FROM users WHERE role = 'temp' AND uuid = ? AND status != 'deleted'")
        .get(uuid) || null
    );
  }

  ensureTempUser(tempId) {
    if (!tempId) return null;
    let user = this.db
      .prepare("SELECT * FROM users WHERE role = 'temp' AND uuid = ? AND status != 'deleted'")
      .get(tempId);
    if (!user) {
      const ts = nowIso();
      const quota = quotaBytesForLevel(this.defaultQuotaGb(), 0);
      const used = new Set(
        this.db
          .prepare("SELECT nickname FROM users WHERE role = 'temp' AND status != 'deleted'")
          .all()
          .map((r) => r.nickname)
          .filter(Boolean)
      );
      const nickname = genTempNickname(used);
      const info = this.db
        .prepare(
          `INSERT INTO users (role, username, uuid, nickname, level, status, quota_bytes, used_bytes, created_at, last_active_at)
           VALUES ('temp', ?, ?, ?, 0, 'normal', ?, 0, ?, ?)`
        )
        .run(null, tempId, nickname, quota, ts, ts);
      user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    }
    return user;
  }

  touchUser(userId) {
    this.db.prepare('UPDATE users SET last_active_at = ? WHERE id = ?').run(nowIso(), userId);
  }

  publicUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      role: user.role,
      username: user.username,
      nickname: user.nickname,
      uuid: user.uuid,
      level: user.level,
      status: user.status,
      displayName: user.nickname || user.username || user.uuid,
    };
  }

  async writeUpload(destDir, fileId, req, maxBytes) {
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, fileId + '.bin');
    const ws = fs.createWriteStream(dest);
    let size = 0;
    try {
      await pipeline(
        Readable.from(req),
        async function* (source) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > maxBytes) {
              const e = new Error('文件超过大小限制');
              e.statusCode = 413;
              throw e;
            }
            yield chunk;
          }
        },
        ws
      );
    } catch (e) {
      removeIfExists(dest);
      throw e;
    }
    return { dest, size };
  }

  async processMedia(file, absoluteDir) {
    const d = this.dirs();
    const src = path.join(absoluteDir, file.id + '.bin');
    try {
      if (file.kind === 'image') {
        const thumb = path.join(d.thumbsDir, file.id + '.jpg');
        await makeImageThumb(src, thumb);
        this.db.prepare('UPDATE files SET thumb_path = ? WHERE id = ?').run(thumb, file.id);
      } else if (file.kind === 'video') {
        const thumb = path.join(d.thumbsDir, file.id + '.jpg');
        const prev = path.join(d.previewsDir, file.id + '.mp4');
        await Promise.all([makeVideoThumb(src, thumb), makeVideoPreview(src, prev)]);
        this.db.prepare('UPDATE files SET thumb_path = ?, preview_path = ? WHERE id = ?').run(
          thumb,
          prev,
          file.id
        );
      } else if (file.kind === 'voice') {
        const needTranscode =
          String(file.mime || '').toLowerCase() !== 'audio/mp4' || file.size > this.cfg.stagingThresholdBytes;
        if (needTranscode) {
          const tmp = path.join(absoluteDir, file.id + '.tmp.m4a');
          await toM4a(src, tmp);
          removeIfExists(src);
          fs.renameSync(tmp, src);
          const size = fs.statSync(src).size;
          this.db
            .prepare("UPDATE files SET mime = 'audio/mp4', size = ? WHERE id = ?")
            .run(size, file.id);
        }
      }
    } catch (e) {
      console.error('[media]', file.id, e.message);
    } finally {
      this.db.prepare('UPDATE files SET ready = 1 WHERE id = ?').run(file.id);
    }
  }

  async uploadRoomFile({ room, user, filename, mime, size, req, expiresAt, folderId = null }) {
    const fileId = randomId(24);
    const maxUpload = this.maxUploadBytes();
    const owner = this.db.prepare('SELECT * FROM users WHERE id = ?').get(room.owner_id);
    const quota = owner ? this.quotaFor(owner) : Infinity;
    if (size > maxUpload) {
      const e = new Error('文件超过全局最大上传大小');
      e.statusCode = 413;
      throw e;
    }
    if (owner && owner.used_bytes + size > quota) {
      const e = new Error('房间所属空间配额不足');
      e.statusCode = 403;
      throw e;
    }
    const dir = path.join(this.getStoragePath(), String(room.id));
    const { dest, size: realSize } = await this.writeUpload(dir, fileId, req, maxUpload);
    if (realSize === 0) {
      removeIfExists(dest);
      const e = new Error('空文件');
      e.statusCode = 400;
      throw e;
    }
    const kind = kindForMime(mime);
    const row = {
      id: fileId,
      scope: 'room',
      ref_id: String(room.id),
      owner_id: user.id,
      filename: safeFilename(filename),
      size: realSize,
      mime: mime || 'application/octet-stream',
      kind,
      path: dest,
      expires_at: expiresAt,
      folder_id: folderId,
    };
    this.db
      .prepare(
        `INSERT INTO files (id, scope, ref_id, owner_id, filename, size, mime, kind, path, folder_id, status, ready, expires_at, created_at)
         VALUES (?, 'room', ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`
      )
      .run(row.id, row.ref_id, row.owner_id, row.filename, row.size, row.mime, row.kind, row.path, row.folder_id, row.expires_at, nowIso());
    if (owner) {
      this.db.prepare('UPDATE users SET used_bytes = used_bytes + ? WHERE id = ?').run(realSize, owner.id);
    }
    const file = this.db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    // 异步处理媒体，完成后广播
    this.processMedia(file, dir).then(() => this.onFileReady?.(this.getFile(fileId)));
    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
  }

  async uploadStagingFile({ session, user, filename, mime, size, req }) {
    const fileId = randomId(24);
    const maxUpload = this.maxUploadBytes();
    const threshold = this.cfg.stagingThresholdBytes;
    if (size > threshold || size > maxUpload) {
      const e = new Error('P2P 暂存仅支持 10M 以下文件');
      e.statusCode = 413;
      throw e;
    }
    const dir = path.join(this.dirs().stagingDir, session.id);
    const { dest, size: realSize } = await this.writeUpload(dir, fileId, req, Math.min(threshold, maxUpload));
    if (realSize === 0) {
      removeIfExists(dest);
      const e = new Error('空文件');
      e.statusCode = 400;
      throw e;
    }
    const kind = kindForMime(mime);
    const accessToken = randomBytes(16).toString('hex');
    this.db
      .prepare(
        `INSERT INTO files (id, scope, ref_id, owner_id, filename, size, mime, kind, path, access_token, status, ready, created_at)
         VALUES (?, 'p2p', ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?)`
      )
      .run(fileId, session.id, user.id, safeFilename(filename), realSize, mime || 'application/octet-stream', kind, dest, accessToken, nowIso());
    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
  }

  deleteFile(fileId, reason) {
    const file = this.db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!file) return null;
    const d = this.dirs();
    const paths = [file.path, file.thumb_path, file.preview_path].filter(Boolean);
    for (const p of paths) removeIfExists(p);
    if (String(file.path || '').toLowerCase().startsWith(d.stagingDir.toLowerCase())) {
      // 清空空目录
      try {
        const dir = path.dirname(file.path);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        // ignore
      }
    }
    if (file.scope === 'room' && file.status === 'active') {
      const room = this.db.prepare('SELECT owner_id FROM rooms WHERE id = ?').get(file.ref_id);
      if (room) {
        this.db
          .prepare('UPDATE users SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?')
          .run(file.size, room.owner_id);
      }
    }
    this.db
      .prepare(
        "UPDATE files SET status = 'deleted', delete_reason = ?, deleted_at = ? WHERE id = ?"
      )
      .run(reason, nowIso(), fileId);
    return file;
  }

  deleteUserFiles(userId, reason) {
    const rows = this.db
      .prepare("SELECT id FROM files WHERE owner_id = ? AND status = 'active' AND scope = 'p2p'")
      .all(userId);
    for (const r of rows) this.deleteFile(r.id, reason);
  }

  getFile(fileId) {
    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
  }

  publicFile(f) {
    if (!f) return null;
    return {
      id: f.id,
      scope: f.scope,
      refId: f.ref_id,
      filename: f.filename,
      size: f.size,
      mime: f.mime,
      kind: f.kind,
      status: f.status,
      deleteReason: f.delete_reason,
      expiresAt: f.expires_at,
      ready: f.ready,
      createdAt: f.created_at,
      ownerId: f.owner_id,
      folderId: f.folder_id ?? null,
      url: `/api/files/${f.id}/download`,
    };
  }

  addMessage({ scope, refId, senderId, senderName, type, content, fileId, clientId }) {
    const info = this.db
      .prepare(
        `INSERT INTO messages (scope, ref_id, sender_id, sender_name, type, content, file_id, client_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(scope, refId, senderId, senderName, type, content || null, fileId || null, clientId || null, nowIso());
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
  }

  isSessionParticipant(sessionId, userId) {
    return this.db
      .prepare('SELECT id FROM sessions WHERE id = ? AND (user_a = ? OR user_b = ?)')
      .get(sessionId, userId, userId);
  }

  isRoomMember(roomId, userId) {
    return this.db
      .prepare('SELECT 1 FROM rooms_users WHERE room_id = ? AND user_id = ? AND left = 0')
      .get(roomId, userId);
  }
}

export function newAccessToken() {
  return randomBytes(32).toString('hex');
}
