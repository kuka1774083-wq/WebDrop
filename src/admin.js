import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Router, sendJson, readJson, nowIso } from './http.js';
import { hashPassword, verifyPassword, formatBytes, quotaBytesForLevel, deleteReasonLabel } from './util.js';
import { setSetting, getSetting } from './db.js';
import { removeUserThemes } from './themes.js';

function requireAdmin(service) {
  return (req, res, next) => {
    const user = service.identify(req);
    if (!user || user.role !== 'admin') {
      sendJson(res, 403, { error: '需要管理员权限' });
      return null;
    }
    return user;
  };
}

async function sampleCpu() {
  const first = os.cpus();
  await new Promise((r) => setTimeout(r, 300));
  const second = os.cpus();
  let idle = 0;
  let total = 0;
  for (let i = 0; i < first.length; i++) {
    const a = first[i].times;
    const b = second[i].times;
    const idleD = b.idle - a.idle;
    const totalD = Object.keys(b).reduce((s, k) => s + (b[k] - a[k]), 0);
    idle += idleD;
    total += totalD;
  }
  return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
}

function dirSize(dir) {
  let total = 0;
  let count = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
          count++;
        } catch {
          // ignore
        }
      }
    }
  };
  walk(dir);
  return { total, count };
}

export function adminRoutes({ db, cfg, service, hub }) {
  const r = new Router();

  r.get('/api/admin/monitor', async (req, res) => {
    const user = requireAdmin(service)(req, res);
    if (!user) return;
    const cpu = await sampleCpu();
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const storagePath = service.getStoragePath();
    let disk = { path: storagePath, total: null, free: null, used: null };
    try {
      const s = fs.statfsSync(storagePath);
      disk = {
        path: storagePath,
        total: s.blocks * s.bsize,
        free: s.bfree * s.bsize,
        used: (s.blocks - s.bfree) * s.bsize,
      };
    } catch {
      // statfs 仅 Linux 可用；Windows 下为空
    }
    const project = dirSize(storagePath);
    sendJson(res, 200, {
      cpu,
      loadavg: os.loadavg?.() || [0, 0, 0],
      memory: {
        total: memTotal,
        free: memFree,
        used: memTotal - memFree,
      },
      disk,
      project: {
        ...project,
        sizeText: formatBytes(project.total),
      },
      storagePath,
    });
  });

  r.get('/api/admin/files', async (req, res) => {
    const user = requireAdmin(service)(req, res);
    if (!user) return;
    const scope = req.query.get('scope');
    const status = req.query.get('status');
    let sql =
      `SELECT f.*, u.role AS owner_role, u.username AS owner_username, u.nickname AS owner_nickname, u.uuid AS owner_uuid
       FROM files f LEFT JOIN users u ON u.id = f.owner_id`;
    const conds = [];
    const args = [];
    if (scope && scope !== 'all') {
      conds.push('f.scope = ?');
      args.push(scope);
    }
    if (status && status !== 'all') {
      conds.push('f.status = ?');
      args.push(status);
    }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY f.created_at DESC LIMIT 1000';
    const rows = db.prepare(sql).all(...args);
    const labels = new Map();
    for (const f of rows) {
      const key = f.ref_id;
      if (labels.has(key)) continue;
      if (f.scope === 'p2p') {
        const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(f.ref_id);
        if (s) {
          const a = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_a);
          const b = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_b);
          labels.set(key, `会话 ${f.ref_id.slice(0, 8)}（${a?.nickname || a?.username || a?.uuid || '?'} ↔ ${b?.nickname || b?.username || b?.uuid || '?'}）`);
        } else {
          labels.set(key, `会话 ${f.ref_id.slice(0, 8)}`);
        }
      } else {
        const room = db.prepare('SELECT room_number FROM rooms WHERE id = ?').get(f.ref_id);
        labels.set(key, room ? `房间 ${room.room_number}` : `房间 #${f.ref_id}`);
      }
    }
    const files = rows.map((f) => ({
      id: f.id,
      scope: f.scope,
      refId: f.ref_id,
      groupLabel: labels.get(f.ref_id),
      filename: f.filename,
      size: f.size,
      sizeText: formatBytes(f.size),
      mime: f.mime,
      kind: f.kind,
      uploader: (f.owner_role === 'temp' ? '[临]' : '') + (f.owner_nickname || f.owner_username || f.owner_uuid || '未知'),
      uploaderRole: f.owner_role,
      expiresAt: f.expires_at,
      status: f.status,
      deleteReason: f.delete_reason,
      deleteReasonText: deleteReasonLabel(f.delete_reason),
      ready: f.ready,
      createdAt: f.created_at,
      deletedAt: f.deleted_at,
    }));
    sendJson(res, 200, { files });
  });

  r.post('/api/admin/files/:id/delete', async (req, res) => {
    const user = requireAdmin(service)(req, res);
    if (!user) return;
    const file = service.getFile(req.params.id);
    if (!file) return sendJson(res, 404, { error: '文件不存在' });
    service.deleteFile(file.id, 'admin_deleted');
    if (file.scope === 'room') {
      const room = db.prepare('SELECT room_number FROM rooms WHERE id = ?').get(file.ref_id);
      if (room) hub.emitRoom(room.room_number, { type: 'roomFileDeleted', number: room.room_number, fileId: file.id });
    }
    sendJson(res, 200, { ok: true });
  });

  r.get('/api/admin/rooms', async (req, res) => {
    const user = requireAdmin(service)(req, res);
    if (!user) return;
    const rows = db
      .prepare(
        `SELECT r.*, u.username AS owner_username, u.nickname AS owner_nickname
         FROM rooms r LEFT JOIN users u ON u.id = r.owner_id
         ORDER BY r.id DESC`
      )
      .all();
    const rooms = rows.map((x) => ({
      id: x.id,
      number: x.room_number,
      title: x.title,
      status: x.status,
      ownerId: x.owner_id,
      ownerName: x.owner_nickname || x.owner_username || '未知',
      destroyAt: x.destroy_at,
      hasPassword: !!x.password_hash,
      maxRetentionDays: x.max_retention_days ?? null,
      maxFileSize: Number(x.max_file_size || 10 * 1024 ** 3),
      createdAt: x.created_at,
    }));
    sendJson(res, 200, { rooms });
  });

  r.get('/api/admin/users', async (req, res) => {
    const user = requireAdmin(service)(req, res);
    if (!user) return;
    const type = req.query.get('type') || 'registered';
    const rows =
      type === 'temp'
        ? db.prepare("SELECT * FROM users WHERE role = 'temp' ORDER BY id DESC LIMIT 1000").all()
        : db.prepare("SELECT * FROM users WHERE role = 'registered' ORDER BY id DESC LIMIT 1000").all();
    const list = rows.map((u) => ({
      id: u.id,
      role: u.role,
      username: u.username,
      uuid: u.uuid,
      nickname: u.nickname,
      email: u.email,
      qq: u.qq,
      level: u.level,
      status: u.status,
      quotaBytes: service.quotaFor(u),
      usedBytes: u.used_bytes,
      createdAt: u.created_at,
      lastActiveAt: u.last_active_at,
      displayName: u.nickname || u.username || u.uuid,
    }));
    sendJson(res, 200, { users: list });
  });

  r.post('/api/admin/users/:id/status', async (req, res) => {
    const user = requireAdmin(service)(req, res);
    if (!user) return;
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!target || target.role === 'admin') {
      return sendJson(res, 400, { error: '目标用户无效' });
    }
    const b = await readJson(req);
    if (target.role === 'temp') {
      if (!['normal', 'banned', 'deleted'].includes(b.status)) {
        return sendJson(res, 400, { error: '临时用户仅可设为 正常/封禁/已删除' });
      }
    } else if (!['normal', 'banned', 'deleted'].includes(b.status)) {
      return sendJson(res, 400, { error: '状态无效' });
    }
    if (b.status === 'deleted') {
      service.deleteUserFiles(target.id, 'user_deleted');
      removeUserThemes(cfg.dataDir, target.uuid);
      db.prepare(
        target.role === 'temp'
          ? 'UPDATE users SET username = NULL, used_bytes = 0 WHERE id = ?'
          : 'UPDATE users SET used_bytes = 0 WHERE id = ?'
      ).run(target.id);
      db.prepare('DELETE FROM tokens WHERE user_id = ?').run(target.id);
    } else if (b.status === 'banned') {
      db.prepare('DELETE FROM tokens WHERE user_id = ?').run(target.id);
    } else if (b.status === 'normal' && target.role === 'registered') {
      const level = Math.max(0, Math.min(6, Number(b.level) || 0));
      db.prepare('UPDATE users SET level = ?, quota_bytes = ? WHERE id = ?').run(
        level,
        quotaBytesForLevel(service.defaultQuotaGb(), level),
        target.id
      );
    }
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(b.status, target.id);
    hub.emitGlobal({ type: 'userStatusChanged', userId: target.id, status: b.status });
    sendJson(res, 200, { ok: true });
  });

  r.post('/api/admin/users/temp-clear', async (req, res) => {
    const user = requireAdmin(service)(req, res);
    if (!user) return;
    const rows = db
      .prepare("SELECT id FROM users WHERE role = 'temp' AND status != 'deleted'")
      .all();
    let count = 0;
    for (const u of rows) {
      service.deleteUserFiles(u.id, 'user_deleted');
      db.prepare('UPDATE users SET username = NULL, used_bytes = 0, status = ? WHERE id = ?').run(
        'deleted',
        u.id
      );
      hub.emitGlobal({ type: 'kickUser', userId: u.id, reason: '已注销' });
      count++;
    }
    sendJson(res, 200, { ok: true, count });
  });

  r.get('/api/admin/approvals', async (req, res) => {
    const user = requireAdmin(service)(req, res);
    if (!user) return;
    const registrations = db
      .prepare("SELECT * FROM registrations WHERE status = 'pending' ORDER BY id ASC")
      .all();
    const roomRequests = db
      .prepare(
        `SELECT rr.*, r.owner_id, r.title, u.username AS owner_username, u.nickname AS owner_nickname
         FROM room_number_requests rr JOIN rooms r ON r.id = rr.room_id
         JOIN users u ON u.id = r.owner_id
         WHERE rr.status = 'pending' ORDER BY rr.id ASC`
      )
      .all();
    sendJson(res, 200, { registrations, roomRequests });
  });

  r.post('/api/admin/approvals/registrations/:id', async (req, res) => {
    const user = requireAdmin(service)(req, res);
    if (!user) return;
    const reg = db
      .prepare("SELECT * FROM registrations WHERE id = ? AND status = 'pending'")
      .get(Number(req.params.id));
    if (!reg) return sendJson(res, 404, { error: '申请不存在或已处理' });
    const b = await readJson(req);
    if (b.action !== 'approve' && b.action !== 'reject') {
      return sendJson(res, 400, { error: 'action 无效' });
    }
    if (b.action === 'approve') {
      const conflict = db
        .prepare("SELECT 1 FROM users WHERE username = ? AND status != 'deleted'")
        .get(reg.username);
      if (conflict) {
        return sendJson(res, 409, { error: '用户名已被占用，无法通过' });
      }
      const ts = nowIso();
      const quota = quotaBytesForLevel(service.defaultQuotaGb(), 0);
      db.prepare(
        `INSERT INTO users (role, username, uuid, nickname, email, qq, password_hash, level, status, quota_bytes, used_bytes, created_at, last_active_at)
         VALUES ('registered', ?, ?, ?, ?, ?, ?, 0, 'normal', ?, 0, ?, ?)`
      ).run(reg.username, randomUUID(), reg.nickname || null, reg.email || null, reg.qq || null, reg.password_hash, quota, ts, ts);
      db.prepare("UPDATE registrations SET status = 'approved', reviewed_at = ? WHERE id = ?").run(ts, reg.id);
      sendJson(res, 200, { ok: true });
    } else {
      db.prepare("UPDATE registrations SET status = 'rejected', reviewed_at = ? WHERE id = ?").run(nowIso(), reg.id);
      sendJson(res, 200, { ok: true });
    }
  });

  r.post('/api/admin/approvals/rooms/:id', async (req, res) => {
    const user = requireAdmin(service)(req, res);
    if (!user) return;
    const rr = db
      .prepare("SELECT * FROM room_number_requests WHERE id = ? AND status = 'pending'")
      .get(Number(req.params.id));
    if (!rr) return sendJson(res, 404, { error: '申请不存在或已处理' });
    const b = await readJson(req);
    if (b.action !== 'approve' && b.action !== 'reject') {
      return sendJson(res, 400, { error: 'action 无效' });
    }
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(rr.room_id);
    if (b.action === 'approve') {
      db.prepare("UPDATE rooms SET status = 'active' WHERE id = ?").run(rr.room_id);
      db.prepare("UPDATE room_number_requests SET status = 'approved', reviewed_at = ? WHERE id = ?").run(nowIso(), rr.id);
      if (room) hub.emitRoom(room.room_number, { type: 'roomApproved', number: room.room_number });
    } else {
      db.prepare("UPDATE rooms SET status = 'destroyed', destroyed_at = ? WHERE id = ?").run(nowIso(), rr.room_id);
      db.prepare("UPDATE room_number_requests SET status = 'rejected', reviewed_at = ? WHERE id = ?").run(nowIso(), rr.id);
    }
    sendJson(res, 200, { ok: true });
  });

  r.get('/api/admin/settings', async (req, res) => {
    const user = requireAdmin(service)(req, res);
    if (!user) return;
    const admin = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get();
    sendJson(res, 200, {
      maxUploadBytes: service.maxUploadBytes(),
      defaultQuotaGb: service.defaultQuotaGb(),
      storagePath: service.getStoragePath(),
      adminUsername: admin?.username,
    });
  });

  r.put('/api/admin/settings', async (req, res) => {
    const user = requireAdmin(service)(req, res);
    if (!user) return;
    const b = await readJson(req);
    if (b.maxUploadBytes !== undefined) {
      const v = Number(b.maxUploadBytes);
      if (!Number.isFinite(v) || v <= 0) return sendJson(res, 400, { error: '最大上传大小无效' });
      setSetting(db, 'maxUploadBytes', v);
    }
    if (b.defaultQuotaGb !== undefined) {
      const v = Number(b.defaultQuotaGb);
      if (!Number.isFinite(v) || v < 1 || v > 100000) return sendJson(res, 400, { error: '配额基准无效' });
      setSetting(db, 'defaultQuotaGb', v);
    }
    if (b.storagePath !== undefined) {
      const p = String(b.storagePath || '').trim();
      if (!p) return sendJson(res, 400, { error: '存储路径不能为空' });
      const resolved = path.isAbsolute(p) ? p : path.resolve(cfg.rootDir, p);
      fs.mkdirSync(resolved, { recursive: true });
      setSetting(db, 'storagePath', resolved);
    }
    sendJson(res, 200, {
      ok: true,
      message: '已保存（配额基准影响新建账号，已有账号在调整等级时按新基准重算）',
    });
  });

  r.post('/api/admin/change-credentials', async (req, res) => {
    const user = requireAdmin(service)(req, res);
    if (!user) return;
    const b = await readJson(req);
    const ok = await verifyPassword(String(b.currentPassword || ''), user.password_hash);
    if (!ok) return sendJson(res, 401, { error: '当前密码错误' });
    const newUsername = String(b.newUsername || '').trim();
    const newPassword = String(b.newPassword || '');
    if (newUsername && newUsername !== user.username) {
      const conflict = db
        .prepare("SELECT 1 FROM users WHERE username = ? AND id != ? AND status != 'deleted'")
        .get(newUsername, user.id);
      if (conflict) return sendJson(res, 409, { error: '用户名已存在' });
    }
    const hash = newPassword ? await hashPassword(newPassword) : user.password_hash;
    db.prepare('UPDATE users SET username = ?, password_hash = ?, must_change = 0 WHERE id = ?').run(
      newUsername || user.username,
      hash,
      user.id
    );
    sendJson(res, 200, { ok: true });
  });

  return r;
}
