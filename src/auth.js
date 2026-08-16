import { Router, sendJson, readJson, token, nowIso } from './http.js';
import { hashPassword, verifyPassword, addMinutes } from './util.js';
import { getSetting } from './db.js';
import { removeUserThemes } from './themes.js';

export function authRoutes({ db, cfg, service, hub }) {
  const r = new Router();

  r.post('/api/auth/register', async (req, res) => {
    const b = await readJson(req);
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    const nickname = String(b.nickname || '').trim();
    const email = String(b.email || '').trim();
    const qq = String(b.qq || '').trim();
    if (!username || !password) {
      return sendJson(res, 400, { error: '用户名和密码不能为空' });
    }
    if (!email && !qq) {
      return sendJson(res, 400, { error: '邮箱或 QQ 号至少填写一种' });
    }
    const adminName = db.prepare("SELECT username FROM users WHERE role = 'admin' LIMIT 1").get()?.username;
    const conflict =
      db.prepare("SELECT 1 FROM users WHERE username = ? AND status != 'deleted'").get(username) ||
      db.prepare("SELECT 1 FROM registrations WHERE username = ? AND status = 'pending'").get(username);
    if (conflict || username === adminName) {
      return sendJson(res, 409, { error: '用户名已存在' });
    }
    const hash = await hashPassword(password);
    db.prepare(
      `INSERT INTO registrations (username, nickname, email, qq, password_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).run(username, nickname, email || null, qq || null, hash, nowIso());
    sendJson(res, 201, { ok: true, pending: true, message: '注册申请已提交，等待管理员审核' });
  });

  r.post('/api/auth/login', async (req, res) => {
    const b = await readJson(req);
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      const reg = db
        .prepare('SELECT status FROM registrations WHERE username = ? ORDER BY id DESC LIMIT 1')
        .get(username);
      if (reg && reg.status === 'pending') {
        return sendJson(res, 403, { error: '账号待审核' });
      }
      return sendJson(res, 401, { error: '用户名或密码错误' });
    }
    if (!user.password_hash) {
      return sendJson(res, 401, { error: '用户名或密码错误' });
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return sendJson(res, 401, { error: '用户名或密码错误' });
    if (user.role !== 'admin') {
      if (user.status === 'pending') return sendJson(res, 403, { error: '账号待审核' });
      if (user.status === 'banned') return sendJson(res, 403, { error: '账号已被封禁' });
      if (user.status === 'deleted') return sendJson(res, 403, { error: '账号已删除' });
    }
    if (user.role === 'registered' && b.deviceId) {
      const dev = db
        .prepare('SELECT status FROM user_devices WHERE user_id = ? AND device_id = ?')
        .get(user.id, String(b.deviceId));
      if (dev && dev.status === 'blacklisted') {
        return sendJson(res, 403, { error: '该设备已被拉黑，无法登录' });
      }
    }
    const t = token();
    db.prepare(
      'INSERT INTO tokens (token, user_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(t, user.id, String(b.deviceId || ''), nowIso(), addMinutes(30 * 24 * 60 * 60 * 1000));
    db.prepare('UPDATE users SET last_active_at = ? WHERE id = ?').run(nowIso(), user.id);
    const usingDefault =
      user.role === 'admin' &&
      username === (cfg.adminUsername || 'admin') &&
      password === (cfg.adminPassword || 'admin');
    const mustChange = user.role === 'admin' && (user.must_change === 1 || usingDefault);
    if (mustChange) {
      db.prepare('UPDATE users SET must_change = 1 WHERE id = ?').run(user.id);
    }
    sendJson(res, 200, {
      token: t,
      user: {
        id: user.id,
        role: user.role,
        username: user.username,
        nickname: user.nickname,
        uuid: user.uuid,
        level: user.level,
        mustChange: mustChange ? true : false,
      },
    });
  });

  r.post('/api/auth/logout', async (req, res) => {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      db.prepare('DELETE FROM tokens WHERE token = ?').run(auth.slice(7));
    }
    sendJson(res, 200, { ok: true });
  });

  r.post('/api/auth/temp-logout', async (req, res) => {
    const tempId = req.headers['x-temp-id'];
    if (!tempId) return sendJson(res, 401, { error: '身份无效' });
    const user = db
      .prepare("SELECT * FROM users WHERE role = 'temp' AND uuid = ? AND status != 'deleted'")
      .get(tempId);
    if (!user) return sendJson(res, 404, { error: '账号不存在' });
    service.deleteUserFiles(user.id, 'user_deleted');
    db.prepare('UPDATE users SET username = NULL, used_bytes = 0, status = ? WHERE id = ?').run('deleted', user.id);
    removeUserThemes(cfg.dataDir, user.uuid);
    hub.emitGlobal({ type: 'kickUser', userId: user.id, reason: '已注销' });
    sendJson(res, 200, { ok: true });
  });

  r.post('/api/auth/change-password', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '未登录' });
    const b = await readJson(req);
    const newPassword = String(b.newPassword || '');
    const newUsername = String(b.newUsername || '').trim();
    if (user.role === 'admin') {
      if (user.must_change === 1) {
        if (!newUsername || !newPassword) {
          return sendJson(res, 400, { error: '管理员首次登录必须修改用户名和密码' });
        }
      } else if (b.currentPassword) {
        const ok = await verifyPassword(b.currentPassword, user.password_hash);
        if (!ok) return sendJson(res, 401, { error: '当前密码错误' });
      } else {
        return sendJson(res, 400, { error: '缺少当前密码' });
      }
      if (newUsername) {
        const conflict = db
          .prepare('SELECT 1 FROM users WHERE username = ? AND id != ?')
          .get(newUsername, user.id);
        if (conflict) return sendJson(res, 409, { error: '用户名已存在' });
      }
      const hash = newPassword ? await hashPassword(newPassword) : user.password_hash;
      db.prepare(
        'UPDATE users SET username = ?, password_hash = ?, must_change = 0 WHERE id = ?'
      ).run(newUsername || user.username, hash, user.id);
      // 撤销其他会话
      db.prepare('DELETE FROM tokens WHERE user_id = ? AND token != ?').run(
        user.id,
        (req.headers.authorization || '').slice(7)
      );
      return sendJson(res, 200, { ok: true });
    }
    // 普通用户改密
    const ok = await verifyPassword(String(b.currentPassword || ''), user.password_hash);
    if (!ok) return sendJson(res, 401, { error: '当前密码错误' });
    if (!newPassword) return sendJson(res, 400, { error: '新密码不能为空' });
    const hash = await hashPassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    sendJson(res, 200, { ok: true });
  });

  r.post('/api/auth/update-profile', async (req, res) => {
    const user = service.identify(req);
    if (!user || user.role !== 'registered') return sendJson(res, 401, { error: '需要登录' });
    const b = await readJson(req);
    const ok = await verifyPassword(String(b.currentPassword || ''), user.password_hash);
    if (!ok) return sendJson(res, 401, { error: '当前密码错误' });
    const nickname =
      b.nickname !== undefined ? String(b.nickname || '').trim().slice(0, 30) : user.nickname;
    let username = user.username;
    if (b.username !== undefined) {
      username = String(b.username || '').trim();
      if (!username) return sendJson(res, 400, { error: '用户名不能为空' });
      const conflict = db
        .prepare("SELECT 1 FROM users WHERE username = ? AND id != ? AND status != 'deleted'")
        .get(username, user.id);
      if (conflict) return sendJson(res, 409, { error: '用户名已存在' });
    }
    let passwordHash = user.password_hash;
    if (b.newPassword) {
      passwordHash = await hashPassword(String(b.newPassword));
    }
    db.prepare('UPDATE users SET username = ?, nickname = ?, password_hash = ? WHERE id = ?').run(
      username,
      nickname || null,
      passwordHash,
      user.id
    );
    sendJson(res, 200, {
      ok: true,
      user: { id: user.id, role: user.role, username, nickname, uuid: user.uuid },
    });
  });

  r.get('/api/auth/devices', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '未登录' });
    const rows = db
      .prepare('SELECT * FROM user_devices WHERE user_id = ? ORDER BY last_seen_at DESC')
      .all(user.id);
    sendJson(res, 200, {
      devices: rows.map((d) => ({
        deviceId: d.device_id,
        name: d.device_name,
        browser: d.browser,
        model: d.model,
        lastSeenAt: d.last_seen_at,
        status: d.status,
        createdAt: d.created_at,
      })),
    });
  });

  r.post('/api/auth/devices/:deviceId/logout', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '未登录' });
    const deviceId = req.params.deviceId;
    db.prepare('DELETE FROM tokens WHERE user_id = ? AND device_id = ?').run(user.id, deviceId);
    // 下线后设备记录消失，除非该设备再次主动上线
    db.prepare('DELETE FROM user_devices WHERE user_id = ? AND device_id = ?').run(user.id, deviceId);
    hub.emitGlobal({ type: 'kickDevice', userId: user.id, deviceId, reason: '设备已下线' });
    sendJson(res, 200, { ok: true });
  });

  r.post('/api/auth/devices/:deviceId/blacklist', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '未登录' });
    const deviceId = req.params.deviceId;
    db.prepare(
      `INSERT INTO user_devices (user_id, device_id, device_name, browser, model, last_seen_at, status, created_at)
       VALUES (?, ?, '', '', '', ?, 'blacklisted', ?)
       ON CONFLICT(user_id, device_id) DO UPDATE SET status = 'blacklisted'`
    ).run(user.id, deviceId, nowIso(), nowIso());
    db.prepare('DELETE FROM tokens WHERE user_id = ? AND device_id = ?').run(user.id, deviceId);
    hub.emitGlobal({ type: 'kickDevice', userId: user.id, deviceId, reason: '设备已被拉黑' });
    sendJson(res, 200, { ok: true });
  });

  r.post('/api/auth/devices/:deviceId/unblacklist', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '未登录' });
    db.prepare(
      "UPDATE user_devices SET status = 'normal' WHERE user_id = ? AND device_id = ?"
    ).run(user.id, req.params.deviceId);
    sendJson(res, 200, { ok: true });
  });

  r.get('/api/auth/me', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '未登录' });
    sendJson(res, 200, {
      user: {
        id: user.id,
        role: user.role,
        username: user.username,
        nickname: user.nickname,
        uuid: user.uuid,
        level: user.level,
        status: user.status,
        usedBytes: user.used_bytes,
        quotaBytes: service.quotaFor(user),
        mustChange: user.must_change === 1,
        theme: user.theme || null,
      },
    });
  });

  return r;
}
