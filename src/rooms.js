import { Router, sendJson, readJson, decodeHeader } from './http.js';
import {
  nowIso,
  isValidCustomRoomNumber,
  genRandomRoomNumber,
  roomQuotaForLevel,
  expiresChoiceToIso,
  displayNameFor,
  hashPassword,
  verifyPassword,
  formatBytes,
} from './util.js';

export function roomRoutes({ db, cfg, service, hub }) {
  const r = new Router();

  function publicRoom(room) {
    const num = room.room_number;
    return {
      id: room.id,
      number: num,
      ownerId: room.owner_id,
      title: room.title,
      status: room.status,
      destroyAt: room.destroy_at,
      createdAt: room.created_at,
      hasPassword: !!room.password_hash,
      maxRetentionDays: room.max_retention_days ?? null,
      maxFileSize: Number(room.max_file_size || 10 * 1024 ** 3),
      roomCapacityBytes: room.room_capacity_bytes ?? null,
      uploadPermission: room.upload_permission || 'all',
      downloadPermission: room.download_permission || 'all',
    };
  }

  r.post('/api/rooms', async (req, res) => {
    const user = service.identify(req);
    if (!user || user.role !== 'registered') {
      return sendJson(res, 401, { error: '开启房间需要登录注册账号' });
    }
    if (user.status !== 'normal') {
      return sendJson(res, 403, { error: user.status === 'banned' ? '账号已被封禁' : '账号不可用' });
    }
    const b = await readJson(req);
    const title = String(b.title || '').trim().slice(0, 60);
    const destroyAt = expiresChoiceToIso(b.destroyAt);
    const password = String(b.password || '');
    const passwordHash = password ? await hashPassword(password) : null;
    const quota = roomQuotaForLevel(user.level);
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM rooms WHERE owner_id = ? AND status IN ('active','pending')")
      .get(user.id).c;
    if (count >= quota) {
      return sendJson(res, 403, { error: `当前会员等级最多开启 ${quota} 个房间` });
    }

    if (b.mode === 'custom') {
      const custom = String(b.customNumber || '').trim();
      if (!isValidCustomRoomNumber(custom)) {
        return sendJson(res, 400, { error: '自定义房间号需为 6-12 位数字、中文或大小写英文' });
      }
      if (db.prepare('SELECT 1 FROM rooms WHERE room_number = ?').get(custom)) {
        return sendJson(res, 409, { error: '该房间号已被占用' });
      }
      const info = db
        .prepare(
          `INSERT INTO rooms (room_number, owner_id, title, status, destroy_at, password_hash, created_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?)`
        )
        .run(custom, user.id, title, destroyAt, passwordHash, nowIso());
      const roomId = info.lastInsertRowid;
      db.prepare(
        'INSERT OR IGNORE INTO rooms_users (room_id, user_id, joined_at) VALUES (?, ?, ?)'
      ).run(roomId, user.id, nowIso());
      db.prepare(
        `INSERT INTO room_number_requests (room_id, requested_number, status, created_at)
         VALUES (?, ?, 'pending', ?)`
      ).run(roomId, custom, nowIso());
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
      return sendJson(res, 201, {
        pending: true,
        message: '自定义房间号需管理员审批，审批通过后房间才可加入',
        room: publicRoom(room),
      });
    }

    // 随机房间号
    const existing = new Set(
      db.prepare('SELECT room_number FROM rooms').all().map((x) => x.room_number)
    );
    const number = genRandomRoomNumber(existing);
    const info = db
      .prepare(
        `INSERT INTO rooms (room_number, owner_id, title, status, destroy_at, password_hash, created_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(number, user.id, title, destroyAt, passwordHash, nowIso());
    db.prepare(
      'INSERT OR IGNORE INTO rooms_users (room_id, user_id, joined_at) VALUES (?, ?, ?)'
    ).run(info.lastInsertRowid, user.id, nowIso());
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(info.lastInsertRowid);
    sendJson(res, 201, { pending: false, room: publicRoom(room) });
  });

  r.get('/api/rooms/mine', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '未登录' });
    const rooms = db
      .prepare("SELECT * FROM rooms WHERE owner_id = ? AND status != 'destroyed' ORDER BY id DESC")
      .all(user.id);
    sendJson(res, 200, { rooms: rooms.map(publicRoom) });
  });

  r.get('/api/rooms/history', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    const rows = db
      .prepare(
        `SELECT r.* FROM rooms_users ru JOIN rooms r ON r.id = ru.room_id
         WHERE ru.user_id = ? AND r.status != 'destroyed' ORDER BY ru.joined_at DESC`
      )
      .all(user.id);
    sendJson(res, 200, { rooms: rows.map(publicRoom) });
  });

  r.get('/api/rooms/:number', async (req, res) => {
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    if (room.status === 'pending') return sendJson(res, 403, { error: '房间待管理员审批' });
    if (room.status === 'destroyed') return sendJson(res, 404, { error: '房间不存在' });
    sendJson(res, 200, { room: publicRoom(room) });
  });

  r.post('/api/rooms/:number/join', async (req, res) => {
    const tempId = req.headers['x-temp-id'];
    let user = service.identify(req);
    if (!user) {
      user = service.ensureTempUser(tempId);
    }
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    if (user.status === 'banned') return sendJson(res, 403, { error: '账号已被封禁' });
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    if (room.status === 'pending') return sendJson(res, 403, { error: '房间待管理员审批' });
    if (room.status === 'destroyed') return sendJson(res, 404, { error: '房间不存在' });
    if (
      db.prepare('SELECT 1 FROM room_blacklist WHERE room_id = ? AND user_id = ?').get(room.id, user.id)
    ) {
      return sendJson(res, 403, { error: '你已被房主拉黑，无法加入该房间' });
    }
    const b = await readJson(req);
    if (room.password_hash) {
      const ok = await verifyPassword(String(b.password || ''), room.password_hash);
      if (!ok) return sendJson(res, 403, { error: '房间密码错误' });
    }
    db.prepare(
      `INSERT INTO rooms_users (room_id, user_id, joined_at, left) VALUES (?, ?, ?, 0)
       ON CONFLICT(room_id, user_id) DO UPDATE SET left = 0`
    ).run(room.id, user.id, nowIso());
    service.touchUser(user.id);
    const members = thisMemberNames(room.id, service, hub);
    hub.emitRoom(room.room_number, { type: 'roomMembers', number: room.room_number, members });
    // 加入提示：2 秒瞬时提示，不写入聊天记录
    hub.emitRoom(room.room_number, {
      type: 'roomNotice',
      content: `${displayNameFor(user, [])} 加入了房间`,
    });
    sendJson(res, 200, { room: publicRoom(room), user: service.publicUser(user), members });
  });

  r.post('/api/rooms/:number/leave', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    db.prepare('UPDATE rooms_users SET left = 1 WHERE room_id = ? AND user_id = ?').run(room.id, user.id);
    const members = thisMemberNames(room.id, service, hub);
    hub.emitRoom(room.room_number, { type: 'roomMembers', number: room.room_number, members });
    sendJson(res, 200, { ok: true });
  });

  r.get('/api/rooms/:number/members', async (req, res) => {
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    sendJson(res, 200, { members: thisMemberNames(room.id, service, hub) });
  });

  function ownerGuard(user, room, res) {
    if (room.owner_id !== user.id && user.role !== 'admin') {
      sendJson(res, 403, { error: '只有房主或管理员可以管理成员' });
      return false;
    }
    return true;
  }

  r.post('/api/rooms/:number/members/:userId/kick', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    if (!ownerGuard(user, room, res)) return;
    const targetId = Number(req.params.userId);
    if (targetId === room.owner_id) return sendJson(res, 400, { error: '不能踢出房主' });
    db.prepare('UPDATE rooms_users SET left = 1 WHERE room_id = ? AND user_id = ?').run(room.id, targetId);
    hub.emitGlobal({ type: 'roomKicked', userId: targetId, number: room.room_number, reason: 'kick' });
    hub.emitRoom(room.room_number, {
      type: 'roomMembers',
      number: room.room_number,
      members: thisMemberNames(room.id, service, hub),
    });
    sendJson(res, 200, { ok: true });
  });

  r.post('/api/rooms/:number/members/:userId/blacklist', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    if (!ownerGuard(user, room, res)) return;
    const targetId = Number(req.params.userId);
    if (targetId === room.owner_id) return sendJson(res, 400, { error: '不能拉黑房主' });
    db.prepare('UPDATE rooms_users SET left = 1 WHERE room_id = ? AND user_id = ?').run(room.id, targetId);
    db.prepare(
      'INSERT OR IGNORE INTO room_blacklist (room_id, user_id, created_at) VALUES (?, ?, ?)'
    ).run(room.id, targetId, nowIso());
    hub.emitGlobal({ type: 'roomKicked', userId: targetId, number: room.room_number, reason: 'blacklist' });
    hub.emitRoom(room.room_number, {
      type: 'roomMembers',
      number: room.room_number,
      members: thisMemberNames(room.id, service, hub),
    });
    sendJson(res, 200, { ok: true });
  });

  r.get('/api/rooms/:number/blacklist', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    if (!ownerGuard(user, room, res)) return;
    const rows = db
      .prepare(
        `SELECT u.id, u.nickname, u.username, u.uuid
         FROM room_blacklist rb JOIN users u ON u.id = rb.user_id
         WHERE rb.room_id = ? ORDER BY rb.created_at DESC`
      )
      .all(room.id);
    sendJson(res, 200, {
      users: rows.map((u) => ({ id: u.id, name: u.nickname || u.username || u.uuid })),
    });
  });

  r.post('/api/rooms/:number/blacklist/:userId/unban', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    if (!ownerGuard(user, room, res)) return;
    db.prepare('DELETE FROM room_blacklist WHERE room_id = ? AND user_id = ?').run(
      room.id,
      Number(req.params.userId)
    );
    sendJson(res, 200, { ok: true });
  });

  r.get('/api/rooms/:number/messages', async (req, res) => {
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    const after = Number(req.query.get('after') || 0);
    const before = Number(req.query.get('before') || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query.get('limit') || 20)));
    let rows;
    let hasMore = false;
    if (before > 0) {
      rows = db
        .prepare(
          "SELECT * FROM messages WHERE scope = ? AND ref_id = ? AND deleted = 0 AND id < ? ORDER BY id DESC LIMIT ?"
        )
        .all('room', String(room.id), before, limit);
      rows.reverse();
      if (rows.length) {
        hasMore = !!db
          .prepare("SELECT 1 FROM messages WHERE scope = ? AND ref_id = ? AND deleted = 0 AND id < ? LIMIT 1")
          .get('room', String(room.id), rows[0].id);
      }
    } else if (after > 0) {
      rows = db
        .prepare(
          "SELECT * FROM messages WHERE scope = ? AND ref_id = ? AND deleted = 0 AND id > ? ORDER BY id ASC LIMIT ?"
        )
        .all('room', String(room.id), after, limit);
    } else {
      // 进入房间默认只取最新的 limit 条
      rows = db
        .prepare(
          "SELECT * FROM messages WHERE scope = ? AND ref_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?"
        )
        .all('room', String(room.id), limit);
      rows.reverse();
      if (rows.length) {
        hasMore = !!db
          .prepare("SELECT 1 FROM messages WHERE scope = ? AND ref_id = ? AND deleted = 0 AND id < ? LIMIT 1")
          .get('room', String(room.id), rows[0].id);
      }
    }
    sendJson(res, 200, { messages: rows, hasMore });
  });

  // 消息管理：房主可查看全部消息（含已删除）
  r.get('/api/rooms/:number/messages/all', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    if (room.owner_id !== user.id) return sendJson(res, 403, { error: '只有房主可以查看消息管理' });
    const page = Math.max(1, Number(req.query.get('page') || 1));
    const pageSize = Math.min(50, Math.max(1, Number(req.query.get('pageSize') || 10)));
    const status = String(req.query.get('status') || 'all');
    const type = String(req.query.get('type') || 'all');
    const q = String(req.query.get('q') || '').trim();
    const conds = ["m.scope = 'room'", 'm.ref_id = ?'];
    const params = [String(room.id)];
    if (status === 'visible') conds.push('m.deleted = 0');
    else if (status === 'deleted') conds.push('m.deleted = 1');
    if (q) {
      conds.push('m.content LIKE ?');
      params.push(`%${q}%`);
    }
    if (type !== 'all') {
      conds.push('m.type = ?');
      params.push(type);
    }
    const where = conds.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) AS c FROM messages m WHERE ${where}`).get(...params).c;
    const rows = db
      .prepare(
        `SELECT m.*, f.status AS file_status, f.filename AS file_name
         FROM messages m LEFT JOIN files f ON f.id = m.file_id
         WHERE ${where} ORDER BY m.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, (page - 1) * pageSize);
    sendJson(res, 200, { messages: rows, total, page, pageSize });
  });

  // 房主删除消息（可多选、可选同时删除对应文件）
  r.post('/api/rooms/:number/messages/delete', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room || room.status !== 'active') return sendJson(res, 410, { error: '房间不可用' });
    if (room.owner_id !== user.id) return sendJson(res, 403, { error: '只有房主可以删除消息' });
    const b = await readJson(req);
    const ids = Array.isArray(b.messageIds)
      ? b.messageIds.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
      : [];
    if (!ids.length) return sendJson(res, 400, { error: '请选择要删除的消息' });
    const deleteFile = !!b.deleteFile;
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT * FROM messages WHERE scope = 'room' AND ref_id = ? AND deleted = 0 AND id IN (${placeholders})`)
      .all(String(room.id), ...ids);
    const activeIds = rows.map((m) => m.id);
    if (!activeIds.length) return sendJson(res, 200, { ok: true, deleted: 0, fileIds: [] });
    db.prepare(`UPDATE messages SET deleted = 1 WHERE id IN (${activeIds.map(() => '?').join(',')})`).run(...activeIds);
    const fileIds = [];
    if (deleteFile) {
      for (const m of rows) {
        if (!m.file_id) continue;
        const file = service.getFile(m.file_id);
        if (!file) continue;
        service.deleteFile(file.id, 'user_manual');
        fileIds.push(file.id);
        hub.emitRoom(room.room_number, { type: 'roomFileDeleted', number: room.room_number, fileId: file.id });
      }
    }
    hub.emitRoom(room.room_number, {
      type: 'roomMessagesDeleted',
      number: room.room_number,
      messageIds: activeIds,
      fileIds,
    });
    sendJson(res, 200, { ok: true, deleted: activeIds.length, fileIds });
  });

  // 房主恢复已删除的消息
  r.post('/api/rooms/:number/messages/restore', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room || room.status !== 'active') return sendJson(res, 410, { error: '房间不可用' });
    if (room.owner_id !== user.id) return sendJson(res, 403, { error: '只有房主可以恢复消息' });
    const b = await readJson(req);
    const ids = Array.isArray(b.messageIds)
      ? b.messageIds.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
      : [];
    if (!ids.length) return sendJson(res, 400, { error: '请选择要恢复的消息' });
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id FROM messages WHERE scope = 'room' AND ref_id = ? AND deleted = 1 AND id IN (${placeholders})`)
      .all(String(room.id), ...ids);
    const activeIds = rows.map((m) => m.id);
    if (activeIds.length) {
      db.prepare(`UPDATE messages SET deleted = 0 WHERE id IN (${activeIds.map(() => '?').join(',')})`).run(...activeIds);
    }
    hub.emitRoom(room.room_number, { type: 'roomMessagesRestored', number: room.room_number, messageIds: activeIds });
    sendJson(res, 200, { ok: true, restored: activeIds.length });
  });

  r.post('/api/rooms/:number/messages', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room || room.status !== 'active') {
      return sendJson(res, 410, { error: '房间不可用' });
    }
    if (!service.isRoomMember(room.id, user.id)) {
      return sendJson(res, 403, { error: '请先加入房间' });
    }
    const b = await readJson(req);
    const content = String(b.content || '').trim().slice(0, 5000);
    if (!content) return sendJson(res, 400, { error: '内容不能为空' });
    const msg = service.addMessage({
      scope: 'room',
      refId: String(room.id),
      senderId: user.id,
      senderName: displayNameFor(user, []),
      type: 'text',
      content,
    });
    hub.emitRoom(room.room_number, { type: 'roomMessage', message: msg, file: null });
    sendJson(res, 201, { message: msg });
  });

  r.get('/api/rooms/:number/files', async (req, res) => {
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    const folders = db
      .prepare('SELECT * FROM room_folders WHERE room_id = ? ORDER BY id ASC')
      .all(String(room.id))
      .map((x) => ({ id: x.id, name: x.name, createdAt: x.created_at }));
    const rows = db
      .prepare(
        "SELECT * FROM files WHERE scope = 'room' AND ref_id = ? ORDER BY created_at DESC"
      )
      .all(String(room.id));
    const now = Date.now();
    const files = rows.map((f) => {
      const pf = service.publicFile(f);
      pf.expired = f.status === 'active' && f.expires_at && Date.parse(f.expires_at) <= now;
      return pf;
    });
    sendJson(res, 200, { files, folders });
  });

  r.post('/api/rooms/:number/files', async (req, res) => {
    const tempId = req.headers['x-temp-id'];
    let user = service.identify(req);
    if (!user) user = service.ensureTempUser(tempId);
    if (!user || user.status === 'banned') {
      return sendJson(res, 401, { error: '身份无效或已封禁' });
    }
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room || room.status !== 'active') return sendJson(res, 410, { error: '房间不可用' });
    if (!service.isRoomMember(room.id, user.id)) {
      return sendJson(res, 403, { error: '请先加入房间' });
    }
    const filename = decodeHeader(req.headers['x-file-name']);
    const mime = decodeHeader(req.headers['x-file-mime']) || 'application/octet-stream';
    let expires = expiresChoiceToIso(decodeHeader(req.headers['x-expires'])) || null;
    const folderRaw = decodeHeader(req.headers['x-folder']) || '';
    let folderId = null;
    if (folderRaw === 'm4a') {
      // 聊天框录音默认归档到 m4a 文件夹（不存在则自动创建），便于房主统一清理
      let fld = db.prepare('SELECT id FROM room_folders WHERE room_id = ? AND name = ?').get(String(room.id), 'm4a');
      if (!fld) {
        const info = db.prepare('INSERT INTO room_folders (room_id, name, created_at) VALUES (?, ?, ?)').run(String(room.id), 'm4a', nowIso());
        fld = { id: info.lastInsertRowid };
      }
      folderId = fld.id;
    } else if (folderRaw) {
      folderId = Number(folderRaw);
      const fld = db.prepare('SELECT id FROM room_folders WHERE id = ? AND room_id = ?').get(folderId, String(room.id));
      if (!fld) return sendJson(res, 400, { error: '文件夹不存在' });
    }
    const size = Number(req.headers['content-length'] || 0);
    if (!filename) return sendJson(res, 400, { error: '缺少文件名' });
    const upPerm = room.upload_permission || 'all';
    if (upPerm === 'owner' && user.id !== room.owner_id) {
      return sendJson(res, 403, { error: '仅房主可上传文件' });
    }
    if (upPerm === 'registered' && user.role !== 'registered') {
      return sendJson(res, 403, { error: '仅登录用户可上传文件' });
    }
    const maxUpload = service.maxUploadBytes();
    const roomMax = Math.min(maxUpload, Number(room.max_file_size) || maxUpload);
    if (size > roomMax) {
      return sendJson(res, 413, { error: `超过房主设置的单文件大小上限（${formatBytes(roomMax)}）` });
    }
    const isOwner = user.id === room.owner_id;
    if (room.max_retention_days && !isOwner) {
      const cap = new Date(Date.now() + room.max_retention_days * 86400e3).toISOString();
      if (!expires || Date.parse(expires) > Date.parse(cap)) expires = cap;
    }
    if (room.room_capacity_bytes) {
      const used = db
        .prepare(
          "SELECT COALESCE(SUM(size), 0) AS s FROM files WHERE scope = 'room' AND ref_id = ? AND status = 'active'"
        )
        .get(String(room.id)).s;
      if (used + size > room.room_capacity_bytes) {
        return sendJson(res, 403, { error: '房间存储空间已达房主设置的上限' });
      }
    }
    const file = await service.uploadRoomFile({
      room,
      user,
      filename,
      mime,
      size,
      req,
      expiresAt: expires,
      folderId,
    });
    const msg = service.addMessage({
      scope: 'room',
      refId: String(room.id),
      senderId: user.id,
      senderName: displayNameFor(user, []),
      type: file.kind === 'voice' ? 'voice' : file.kind === 'image' ? 'image' : file.kind === 'video' ? 'video' : 'file',
      content: file.filename,
      fileId: file.id,
    });
    hub.emitRoom(room.room_number, {
      type: 'roomMessage',
      message: msg,
      file: service.publicFile(file),
    });
    sendJson(res, 201, { file: service.publicFile(file), message: msg });
  });

  r.delete('/api/rooms/:number/files/:fileId', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    const file = service.getFile(req.params.fileId);
    if (!file) return sendJson(res, 404, { error: '文件不存在' });
    if (!room || room.owner_id !== user.id) return sendJson(res, 403, { error: '只有房主可以删除文件' });
    service.deleteFile(file.id, user.role === 'admin' ? 'admin_deleted' : 'user_manual');
    if (room) {
      hub.emitRoom(room.room_number, { type: 'roomFileDeleted', number: room.room_number, fileId: file.id });
    }
    sendJson(res, 200, { ok: true });
  });

  // ---- 房间文件夹 ----
  function folderAuth(room, user) {
    if (!user) return '身份无效';
    if (!room) return '房间不存在';
    if (room.owner_id !== user.id) return '只有房主可以管理文件夹';
    return null;
  }

  r.post('/api/rooms/:number/folders', async (req, res) => {
    const user = service.identify(req);
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    const authErr = folderAuth(room, user);
    if (authErr) return sendJson(res, authErr === '身份无效' ? 401 : authErr === '房间不存在' ? 404 : 403, { error: authErr });
    const b = await readJson(req);
    const name = String(b.name || '').trim().replace(/[\/\\]/g, '').slice(0, 60);
    if (!name) return sendJson(res, 400, { error: '文件夹名称不能为空' });
    const dup = db.prepare('SELECT id FROM room_folders WHERE room_id = ? AND name = ?').get(String(room.id), name);
    if (dup) return sendJson(res, 409, { error: '同名文件夹已存在' });
    const info = db.prepare('INSERT INTO room_folders (room_id, name, created_at) VALUES (?, ?, ?)').run(String(room.id), name, nowIso());
    sendJson(res, 201, { ok: true, folder: { id: info.lastInsertRowid, name, createdAt: nowIso() } });
  });

  r.put('/api/rooms/:number/folders/:folderId', async (req, res) => {
    const user = service.identify(req);
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    const authErr = folderAuth(room, user);
    if (authErr) return sendJson(res, authErr === '身份无效' ? 401 : authErr === '房间不存在' ? 404 : 403, { error: authErr });
    const folder = db.prepare('SELECT * FROM room_folders WHERE id = ? AND room_id = ?').get(Number(req.params.folderId), String(room.id));
    if (!folder) return sendJson(res, 404, { error: '文件夹不存在' });
    const b = await readJson(req);
    const name = String(b.name || '').trim().replace(/[\/\\]/g, '').slice(0, 60);
    if (!name) return sendJson(res, 400, { error: '文件夹名称不能为空' });
    const dup = db.prepare('SELECT id FROM room_folders WHERE room_id = ? AND name = ? AND id != ?').get(String(room.id), name, folder.id);
    if (dup) return sendJson(res, 409, { error: '同名文件夹已存在' });
    db.prepare('UPDATE room_folders SET name = ? WHERE id = ?').run(name, folder.id);
    sendJson(res, 200, { ok: true, folder: { id: folder.id, name } });
  });

  r.delete('/api/rooms/:number/folders/:folderId', async (req, res) => {
    const user = service.identify(req);
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    const authErr = folderAuth(room, user);
    if (authErr) return sendJson(res, authErr === '身份无效' ? 401 : authErr === '房间不存在' ? 404 : 403, { error: authErr });
    const folder = db.prepare('SELECT * FROM room_folders WHERE id = ? AND room_id = ?').get(Number(req.params.folderId), String(room.id));
    if (!folder) return sendJson(res, 404, { error: '文件夹不存在' });
    // 删除文件夹时文件回到根目录，避免误删数据
    db.prepare('UPDATE files SET folder_id = NULL WHERE folder_id = ?').run(folder.id);
    db.prepare('DELETE FROM room_folders WHERE id = ?').run(folder.id);
    sendJson(res, 200, { ok: true });
  });

  // ---- 文件：移动 / 重命名 ----
  r.post('/api/rooms/:number/files/:fileId/move', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    const file = service.getFile(req.params.fileId);
    if (!file || file.scope !== 'room') return sendJson(res, 404, { error: '文件不存在' });
    if (!room || room.owner_id !== user.id) return sendJson(res, 403, { error: '只有房主可以移动文件' });
    const b = await readJson(req);
    const folderId = b.folderId == null || b.folderId === '' ? null : Number(b.folderId);
    if (folderId != null) {
      const fld = db.prepare('SELECT id FROM room_folders WHERE id = ? AND room_id = ?').get(folderId, String(room.id));
      if (!fld) return sendJson(res, 400, { error: '文件夹不存在' });
    }
    db.prepare('UPDATE files SET folder_id = ? WHERE id = ?').run(folderId, file.id);
    const updated = service.getFile(file.id);
    if (room) hub.emitRoom(room.room_number, { type: 'roomFileUpdated', number: room.room_number, file: service.publicFile(updated) });
    sendJson(res, 200, { ok: true, file: service.publicFile(updated) });
  });

  r.post('/api/rooms/:number/files/:fileId/rename', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    const file = service.getFile(req.params.fileId);
    if (!file || file.scope !== 'room') return sendJson(res, 404, { error: '文件不存在' });
    if (!room || room.owner_id !== user.id) return sendJson(res, 403, { error: '只有房主可以重命名文件' });
    const b = await readJson(req);
    const name = String(b.name || '').trim().replace(/[\/\\]/g, '').slice(0, 200);
    if (!name) return sendJson(res, 400, { error: '文件名不能为空' });
    db.prepare('UPDATE files SET filename = ? WHERE id = ?').run(name, file.id);
    // 同步消息内容，保证聊天气泡显示新名称
    db.prepare('UPDATE messages SET content = ? WHERE file_id = ?').run(name, file.id);
    const updated = service.getFile(file.id);
    if (room) hub.emitRoom(room.room_number, { type: 'roomFileUpdated', number: room.room_number, file: service.publicFile(updated) });
    sendJson(res, 200, { ok: true, file: service.publicFile(updated) });
  });

  r.put('/api/rooms/:number', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    if (room.owner_id !== user.id && user.role !== 'admin') {
      return sendJson(res, 403, { error: '只有房主或管理员可以修改房间' });
    }
    const b = await readJson(req);
    const title = b.title !== undefined ? String(b.title || '').trim().slice(0, 60) : room.title;
    let passwordHash = room.password_hash;
    if (b.password !== undefined) {
      const pw = String(b.password || '');
      passwordHash = pw ? await hashPassword(pw) : null;
    }
    let maxRetentionDays = room.max_retention_days ?? null;
    if (b.maxRetentionDays !== undefined) {
      const v = b.maxRetentionDays === null || b.maxRetentionDays === '' ? null : Number(b.maxRetentionDays);
      maxRetentionDays = v == null || Number.isNaN(v) ? null : Math.max(1, Math.min(3650, Math.round(v)));
    }
    let maxFileSize = Number(room.max_file_size || 10 * 1024 ** 3);
    if (b.maxFileSize !== undefined) {
      const v = Number(b.maxFileSize);
      if (!Number.isFinite(v) || v < 1024 * 1024 || v > 10 * 1024 ** 3) {
        return sendJson(res, 400, { error: '单文件大小上限需在 1M - 10G 之间' });
      }
      maxFileSize = v;
    }
    let roomCapacityBytes = room.room_capacity_bytes ?? null;
    if (b.roomCapacityBytes !== undefined) {
      const raw = b.roomCapacityBytes === '' ? null : Number(b.roomCapacityBytes);
      const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(room.owner_id);
      const ownerQuota = owner ? service.quotaFor(owner) : 100 * 1024 ** 3;
      if (raw == null || Number.isNaN(raw) || raw <= 0) {
        roomCapacityBytes = null;
      } else if (raw > ownerQuota) {
        return sendJson(res, 400, { error: '房间文件总容量不能超过房主的持久空间' });
      } else {
        roomCapacityBytes = Math.floor(raw);
      }
    }
    const PERMS = ['all', 'owner', 'registered'];
    let uploadPermission = room.upload_permission || 'all';
    let downloadPermission = room.download_permission || 'all';
    if (b.uploadPermission !== undefined) {
      if (!PERMS.includes(b.uploadPermission)) return sendJson(res, 400, { error: '上传权限无效' });
      uploadPermission = b.uploadPermission;
    }
    if (b.downloadPermission !== undefined) {
      if (!PERMS.includes(b.downloadPermission)) return sendJson(res, 400, { error: '下载权限无效' });
      downloadPermission = b.downloadPermission;
    }
    db.prepare(
      `UPDATE rooms SET title = ?, password_hash = ?, max_retention_days = ?, max_file_size = ?,
       room_capacity_bytes = ?, upload_permission = ?, download_permission = ? WHERE id = ?`
    ).run(
      title,
      passwordHash,
      maxRetentionDays,
      maxFileSize,
      roomCapacityBytes,
      uploadPermission,
      downloadPermission,
      room.id
    );
    const updated = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id);
    sendJson(res, 200, { ok: true, room: publicRoom(updated) });
  });

  r.delete('/api/rooms/:number', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    const room = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(req.params.number);
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    if (room.owner_id !== user.id && user.role !== 'admin') {
      return sendJson(res, 403, { error: '只有房主或管理员可以销毁房间' });
    }
    destroyRoom(db, service, room);
    hub.emitRoom(room.room_number, { type: 'roomDestroyed', number: room.room_number });
    sendJson(res, 200, { ok: true });
  });

  return r;
}

function thisMemberNames(roomId, service, hub) {
  const rows = service.db
    .prepare(
      `SELECT u.id, u.role, u.username, u.nickname, u.uuid
       FROM rooms_users ru JOIN users u ON u.id = ru.user_id
       WHERE ru.room_id = ? AND ru.left = 0 ORDER BY ru.joined_at`
    )
    .all(roomId);
  const names = rows
    .filter((u) => hub.online.has(u.id)) // 仅显示在线成员
    .map((u) => ({
    id: u.id,
    name: u.nickname || u.username || u.uuid,
    role: u.role,
    uuid: u.uuid,
    }));
  // 重名时追加 UUID 后 4 位
  const counts = {};
  for (const n of names) counts[n.name] = (counts[n.name] || 0) + 1;
  return names.map((n) => ({
    ...n,
    displayName: counts[n.name] > 1 && n.uuid ? `${n.name}#${n.uuid.slice(-4)}` : n.name,
  }));
}

export function destroyRoom(db, service, room, reason = 'room_destroyed') {
  const rows = db
    .prepare("SELECT id FROM files WHERE scope = 'room' AND ref_id = ? AND status = 'active'")
    .all(String(room.id));
  for (const f of rows) service.deleteFile(f.id, reason);
  db.prepare('UPDATE rooms SET status = ?, destroyed_at = ? WHERE id = ?').run(
    'destroyed',
    nowIso(),
    room.id
  );
}
