import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { nowIso } from './util.js';

export class Hub {
  constructor() {
    this.sessionListeners = new Set();
    this.roomListeners = new Set();
    this.globalListeners = new Set();
    this.online = new Set(); // 当前在线的用户 id（用于房间成员在线过滤）
  }

  emitSession(id, msg) {
    for (const fn of this.sessionListeners) fn(id, msg);
  }

  emitRoom(number, msg) {
    for (const fn of this.roomListeners) fn(number, msg);
  }

  emitGlobal(msg) {
    for (const fn of this.globalListeners) fn(msg);
  }
}

function makeFrame(header, payload) {
  const h = Buffer.from(JSON.stringify(header));
  const out = Buffer.allocUnsafe(4 + h.length + (payload ? payload.length : 0));
  out.writeUInt32BE(h.length, 0);
  h.copy(out, 4);
  if (payload) payload.copy(out, 4 + h.length);
  return out;
}

function parseFrame(buf) {
  const len = buf.readUInt32BE(0);
  const header = JSON.parse(buf.slice(4, 4 + len).toString('utf8'));
  return { header, payload: buf.subarray(4 + len) };
}

export class WsServer {
  constructor({ httpServer, db, cfg, service, hub }) {
    this.db = db;
    this.cfg = cfg;
    this.service = service;
    this.hub = hub;
    this.clients = new Map(); // ws -> info
    this.byDevice = new Map(); // deviceKey -> ws（会话按设备路由）
    this.byUserId = new Map(); // userId -> ws（最近一个连接，用于踢人）
    this.byIdentity = new Map(); // 同一浏览器/同一登录身份 -> ws（多开检测）
    this.sessions = new Map(); // sessionId -> {a,b,relay,watchdog,relaySizes,net,offer}
    this.busyDevices = new Set(); // 正在会话中的设备

    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    this.wss.on('connection', (ws) => this.onConnection(ws));

    hub.sessionListeners.add((sessionId, msg) => this.dispatchSessionEvent(sessionId, msg));
    hub.roomListeners.add((number, msg) => this.dispatchRoomEvent(number, msg));
    hub.globalListeners.add((msg) => this.dispatchGlobalEvent(msg));
    hub.globalListeners.add((msg) => {
      if (msg.type !== 'kickUser') return;
      for (const [ws, info] of this.clients) {
        if (info.user.id === msg.userId) {
          this.send(ws, { type: 'kicked', reason: msg.reason || '会话已注销' });
          ws.close(4004, 'logged out');
        }
      }
    });
    hub.globalListeners.add((msg) => {
      if (msg.type !== 'roomKicked') return;
      for (const [ws, info] of this.clients) {
        if (info.user.id === msg.userId) {
          this.send(ws, { type: 'roomKicked', number: msg.number, reason: msg.reason });
        }
      }
    });
    hub.globalListeners.add((msg) => {
      if (msg.type !== 'kickDevice') return;
      for (const [ws, info] of this.clients) {
        if (info.user.id === msg.userId && info.deviceId === msg.deviceId) {
          this.send(ws, { type: 'deviceKicked', reason: msg.reason || '设备已被下线' });
          ws.close(4007, 'device kicked');
        }
      }
    });
  }

  send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  sendTo(deviceKey, obj) {
    this.send(this.byDevice.get(deviceKey), obj);
  }

  deviceEntries() {
    const countByUser = new Map();
    for (const [, info] of this.clients) {
      if (!info.visible) continue;
      countByUser.set(info.user.id, (countByUser.get(info.user.id) || 0) + 1);
    }
    const list = [];
    for (const [, info] of this.clients) {
      if (!info.visible) continue;
      const base = info.user.nickname || info.user.username || info.user.uuid;
      const multi = countByUser.get(info.user.id) > 1;
      list.push({
        key: info.deviceKey,
        userId: info.user.id,
        name: multi && info.deviceId ? `${base}[${info.deviceId.slice(-4)}]` : base,
        baseName: base,
        deviceId: info.deviceId || '',
        role: info.user.role,
        onlineSince: info.onlineSince,
        busy: this.busyDevices.has(info.deviceKey),
      });
    }
    return list.sort((a, b) => a.onlineSince.localeCompare(b.onlineSince));
  }

  broadcastOnline() {
    const devices = this.deviceEntries();
    for (const [ws] of this.clients) this.send(ws, { type: 'onlineList', devices });
  }

  onConnection(ws) {
    ws.isAlive = true;
    ws.lastPong = Date.now();
    ws.helloTimer = setTimeout(() => {
      if (!ws.handshaken) ws.close(4000, 'hello timeout');
    }, 15000);

    ws.on('pong', () => {
      ws.isAlive = true;
      ws.lastPong = Date.now();
    });
    ws.on('message', (data, isBinary) => this.onMessage(ws, data, isBinary));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => this.onClose(ws));
  }

  identifyFromHello(b) {
    const auth = b.token;
    if (auth) {
      const row = this.db
        .prepare(
          `SELECT u.* FROM tokens tk JOIN users u ON u.id = tk.user_id
           WHERE tk.token = ? AND tk.expires_at > ?`
        )
        .get(auth, nowIso());
      if (row) return row;
    }
    if (b.tempId) {
      const u = this.service.ensureTempUser(b.tempId);
      if (u && u.status === 'banned') {
        this.send(ws, { type: 'error', error: '账号已被封禁' });
        ws.close(4003, 'banned');
        return null;
      }
      return u;
    }
    return null;
  }

  onMessage(ws, data, isBinary) {
    if (isBinary) {
      return this.onBinary(ws, data);
    }
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!ws.handshaken) {
      if (msg.type !== 'hello') return;
      const user = this.identifyFromHello(msg);
      if (!user) {
        this.send(ws, { type: 'error', error: '身份无效' });
        return ws.close(4001, 'unauthorized');
      }
      clearTimeout(ws.helloTimer);
      ws.handshaken = true;
      ws.user = user;
      const deviceId = String(msg.deviceId || '');
      const deviceKey =
        user.role === 'temp'
          ? `t:${user.uuid}`
          : user.role === 'admin'
            ? `admin:${user.id}:${randomUUID()}`
          : `u:${user.id}:${deviceId || randomUUID()}`;
      const identityKey =
        user.role === 'temp'
          ? `temp:${user.uuid}`
          : user.role === 'admin'
            ? `admin:${user.id}:${randomUUID()}`
            : `token:${msg.token || ''}`;
      if (user.role === 'registered' && deviceId) {
        const di = msg.deviceInfo || {};
        this.db
          .prepare(
            `INSERT INTO user_devices (user_id, device_id, device_name, browser, model, last_seen_at, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'normal', ?)
             ON CONFLICT(user_id, device_id) DO UPDATE SET
               browser = excluded.browser, model = excluded.model, device_name = excluded.device_name,
               last_seen_at = excluded.last_seen_at,
               status = CASE WHEN user_devices.status = 'blacklisted' THEN 'blacklisted' ELSE 'normal' END`
          )
          .run(
            user.id,
            deviceId,
            `${di.browser || ''} ${di.model || ''}`.trim(),
            di.browser || '',
            di.model || '',
            nowIso(),
            nowIso()
          );
        const dev = this.db
          .prepare('SELECT status FROM user_devices WHERE user_id = ? AND device_id = ?')
          .get(user.id, deviceId);
        if (dev && dev.status === 'blacklisted') {
          this.send(ws, { type: 'error', error: '该设备已被拉黑' });
          ws.close(4006, 'device blacklisted');
          return;
        }
      }
      ws.info = {
        user,
        deviceId,
        deviceKey,
        onlineSince: nowIso(),
        visible: user.role !== 'admin',
        rooms: new Set(),
        identityKey,
      };
      // 管理员允许多开；普通用户/临时用户做单开检测
      if (user.role !== 'admin') {
        // 同一设备重复连接：保留旧连接，拒绝新连接
        const existingDevice = this.byDevice.get(deviceKey);
        if (existingDevice && existingDevice !== ws && existingDevice.readyState === WebSocket.OPEN && existingDevice.isAlive) {
          this.send(ws, { type: 'multiOpen', reason: '本页面不支持多开' });
          ws.close(4005, 'multi-open');
          return;
        }
        // 同一浏览器/登录身份多开检测
        const existing = this.byIdentity.get(identityKey);
        if (existing && existing !== ws && existing.readyState === WebSocket.OPEN && existing.isAlive) {
          this.send(ws, { type: 'multiOpen', reason: '本页面不支持多开' });
          ws.close(4005, 'multi-open');
          return;
        }
      }
      // 异常断线后重连：仅清理该设备自己的繁忙标记（其他设备互不影响）
      this.busyDevices.delete(deviceKey);
      this.byDevice.set(deviceKey, ws);
      this.byIdentity.set(identityKey, ws);
      this.byUserId.set(user.id, ws);
      this.clients.set(ws, ws.info);
      this.hub.online.add(user.id);
      this.service.touchUser(user.id);
      this.send(ws, {
        type: 'hello',
        user: this.service.publicUser(user),
        deviceKey,
        devices: this.deviceEntries(),
      });
      this.broadcastOnline();
      return;
    }

    const user = ws.user;
    switch (msg.type) {
      case 'ping':
        return this.send(ws, { type: 'pong' });
      case 'filePick':
        // 选择文件期间把该连接的心跳超时放宽到 5 分钟，避免选太久被断开
        ws.filePick = !!msg.active;
        return;
      case 'roomJoin':
        ws.info.rooms.add(msg.number);
        return this.send(ws, { type: 'roomJoined', number: msg.number });
      case 'roomLeave':
        ws.info.rooms.delete(msg.number);
        return;
      case 'sessionRequest':
        return this.sessionRequest(ws, msg);
      case 'sessionAccept':
        return this.sessionAccept(ws, msg);
      case 'sessionDecline':
        return this.sessionDecline(ws, msg);
      case 'sessionEnd':
        return this.sessionEnd(ws, msg);
      case 'signal':
        return this.forwardSignal(ws, msg);
      case 'p2pUp':
        return this.p2pUp(ws, msg);
      case 'useRelay':
        return this.setRelay(ws, msg, true);
      case 'text':
        return this.relayText(ws, msg);
      case 'textPersist':
        return this.persistText(ws, msg);
      case 'fileOffer':
        return this.fileOffer(ws, msg);
      case 'fileAccept':
        return this.forwardControl(ws, msg, 'fileAccepted');
      case 'fileDecline':
        return this.forwardControl(ws, msg, 'fileDeclined');
      case 'fileDone':
        return this.forwardControl(ws, msg, 'fileDone');
      case 'fileCancel':
        return this.forwardControl(ws, msg, 'fileCanceled');
      case 'ack':
        return this.forwardControl(ws, msg, 'ack');
      default:
        break;
    }
  }

  getSession(id) {
    return this.sessions.get(id);
  }

  peerOf(ws, sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return s.a === ws.info.deviceKey ? s.b : s.a;
  }

  sessionRequest(ws, msg) {
    const target = this.byDevice.get(msg.target);
    if (!target || !target.handshaken) {
      return this.send(ws, { type: 'error', error: '对方不在线' });
    }
    if (target.info.deviceKey === ws.info.deviceKey) {
      return this.send(ws, { type: 'error', error: '不能与自己（同一设备）建立会话' });
    }
    if (this.busyDevices.has(target.info.deviceKey)) {
      return this.send(ws, { type: 'error', error: '对方正忙，无法发起会话' });
    }
    if (this.busyDevices.has(ws.info.deviceKey)) {
      return this.send(ws, { type: 'error', error: '你正在其他会话中' });
    }
    if (target.user.role === 'admin' || ws.user.role === 'admin') {
      return this.send(ws, { type: 'error', error: '管理员不参与文件传输' });
    }
    let id = String(msg.sessionId || '');
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) {
      id = `S${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }
    if (this.sessions.has(id) || this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)) {
      id = `S${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_a, user_b, device_a, device_b, status, relay_mode, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`
      )
      .run(id, ws.user.id, target.user.id, ws.info.deviceKey, target.info.deviceKey, nowIso());
    this.sessions.set(id, {
      a: ws.info.deviceKey,
      b: target.info.deviceKey,
      relay: false,
      watchdog: null,
      offer: msg.offer || null,
      relaySizes: new Map(),
      net: msg.net || [],
    });
    const base = ws.user.nickname || ws.user.username || ws.user.uuid;
    this.send(target, {
      type: 'incomingRequest',
      sessionId: id,
      from: {
        key: ws.info.deviceKey,
        userId: ws.user.id,
        name: base,
        deviceId: ws.info.deviceId,
      },
      offer: msg.offer || null,
      net: msg.net || [],
    });
  }

  sessionAccept(ws, msg) {
    const s = this.sessions.get(msg.sessionId);
    if (!s || s.b !== ws.info.deviceKey) return;
    if (this.busyDevices.has(s.a) || this.busyDevices.has(s.b)) {
      this.send(ws, { type: 'error', error: '会话已失效' });
      this.endSession(msg.sessionId);
      return;
    }
    this.busyDevices.add(s.a);
    this.busyDevices.add(s.b);
    this.broadcastOnline();
    this.db.prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run(msg.sessionId);
    this.sendTo(s.a, {
      type: 'sessionAccepted',
      sessionId: msg.sessionId,
      answer: msg.answer,
      net: msg.net || [],
    });
    for (const key of [s.a, s.b]) {
      this.sendTo(key, {
        type: 'sessionStart',
        sessionId: msg.sessionId,
        relay: false,
        peer: key === s.a ? s.b : s.a,
      });
    }
    s.watchdog = setTimeout(() => {
      if (this.sessions.get(msg.sessionId) && !s.p2p) {
        s.relay = true;
        this.db.prepare('UPDATE sessions SET relay_mode = 1 WHERE id = ?').run(msg.sessionId);
        for (const key of [s.a, s.b]) {
          this.sendTo(key, { type: 'sessionMode', sessionId: msg.sessionId, relay: true });
        }
      }
    }, 12000);
  }

  sessionDecline(ws, msg) {
    const s = this.sessions.get(msg.sessionId);
    if (!s) return;
    this.endSession(msg.sessionId);
    this.sendTo(s.a, { type: 'requestDeclined', sessionId: msg.sessionId });
  }

  sessionEnd(ws, msg) {
    const s = this.sessions.get(msg.sessionId);
    if (!s || (s.a !== ws.info.deviceKey && s.b !== ws.info.deviceKey)) return;
    const peer = s.a === ws.info.deviceKey ? s.b : s.a;
    this.endSession(msg.sessionId);
    this.sendTo(peer, { type: 'sessionEnded', sessionId: msg.sessionId });
    this.send(ws, { type: 'sessionEnded', sessionId: msg.sessionId });
  }

  forwardSignal(ws, msg) {
    const peer = this.peerOf(ws, msg.sessionId);
    if (peer == null) return;
    this.sendTo(peer, { type: 'signal', sessionId: msg.sessionId, payload: msg.payload });
  }

  p2pUp(ws, msg) {
    const s = this.sessions.get(msg.sessionId);
    if (!s) return;
    s.p2p = true;
    s.relay = false;
    if (s.watchdog) clearTimeout(s.watchdog);
    this.db.prepare('UPDATE sessions SET relay_mode = 0 WHERE id = ?').run(msg.sessionId);
    for (const key of [s.a, s.b]) {
      this.sendTo(key, { type: 'sessionMode', sessionId: msg.sessionId, relay: false });
    }
  }

  setRelay(ws, msg, val) {
    const s = this.sessions.get(msg.sessionId);
    if (!s) return;
    s.relay = val;
    this.db.prepare('UPDATE sessions SET relay_mode = ? WHERE id = ?').run(val ? 1 : 0, msg.sessionId);
    for (const key of [s.a, s.b]) {
      this.sendTo(key, { type: 'sessionMode', sessionId: msg.sessionId, relay: val });
    }
  }

  relayText(ws, msg) {
    const s = this.sessions.get(msg.sessionId);
    if (!s) return;
    const peer = this.peerOf(ws, msg.sessionId);
    if (peer == null) return;
    const content = String(msg.content || '').trim().slice(0, 5000);
    if (!content) return;
    const name = ws.user.nickname || ws.user.username || ws.user.uuid;
    const message = this.service.addMessage({
      scope: 'p2p',
      refId: msg.sessionId,
      senderId: ws.user.id,
      senderName: name,
      type: 'text',
      content,
      clientId: msg.clientId || null,
    });
    this.sendTo(peer, { type: 'text', sessionId: msg.sessionId, message });
  }

  /** 直连（DataChannel）模式下的文本消息：仅落库供补拉，不转发（对方已通过 P2P 收到） */
  persistText(ws, msg) {
    const s = this.sessions.get(msg.sessionId);
    if (!s) return;
    if (this.peerOf(ws, msg.sessionId) == null) return;
    const content = String(msg.content || '').trim().slice(0, 5000);
    if (!content) return;
    const name = ws.user.nickname || ws.user.username || ws.user.uuid;
    this.service.addMessage({
      scope: 'p2p',
      refId: msg.sessionId,
      senderId: ws.user.id,
      senderName: name,
      type: 'text',
      content,
      clientId: msg.clientId || null,
    });
  }

  fileOffer(ws, msg) {
    const s = this.sessions.get(msg.sessionId);
    if (!s) return;
    const peer = this.peerOf(ws, msg.sessionId);
    if (peer == null) return;
    const name = ws.user.nickname || ws.user.username || ws.user.uuid;
    this.service.addMessage({
      scope: 'p2p',
      refId: msg.sessionId,
      senderId: ws.user.id,
      senderName: name,
      type: msg.kind === 'voice' ? 'voice' : msg.kind === 'image' ? 'image' : msg.kind === 'video' ? 'video' : 'file',
      content: String(msg.name || '文件'),
    });
    this.sendTo(peer, {
      type: 'fileOffer',
      sessionId: msg.sessionId,
      transferId: msg.transferId,
      name: msg.name,
      size: msg.size,
      mime: msg.mime,
      kind: msg.kind,
      from: { id: ws.user.id, name },
    });
  }

  forwardControl(ws, msg, outType) {
    const peer = this.peerOf(ws, msg.sessionId);
    if (peer == null) return;
    const { sessionId, transferId, seq } = msg;
    this.sendTo(peer, { type: outType, sessionId, transferId, seq });
  }

  onBinary(ws, buf) {
    let frame;
    try {
      frame = parseFrame(buf);
    } catch {
      return;
    }
    const { header, payload } = frame;
    if (header.type !== 'fileChunk') return;
    const peer = this.peerOf(ws, header.sessionId);
    if (peer == null) return;
    const s = this.sessions.get(header.sessionId);
    const prev = s?.relaySizes.get(header.transferId) || 0;
    const next = prev + payload.length;
    if (next > this.cfg.maxUploadBytes) {
      if (s) {
        for (const key of [s.a, s.b]) {
          this.sendTo(key, { type: 'fileTooBig', sessionId: header.sessionId, transferId: header.transferId });
        }
      }
      return;
    }
    if (s) {
      s.relaySizes.set(header.transferId, next);
      if (header.done) s.relaySizes.delete(header.transferId);
    }
    const target = this.byDevice.get(peer);
    if (!target || !target.handshaken) return;
    const frame2 = makeFrame(header, payload);
    target.send(frame2, { binary: true }, () => {
      if (s && target.bufferedAmount > 8 * 1024 * 1024 && !ws.paused) {
        ws.paused = true;
        try {
          ws._socket.pause();
        } catch {
          // ignore
        }
        const timer = setInterval(() => {
          if (target.bufferedAmount < 2 * 1024 * 1024) {
            clearInterval(timer);
            if (ws.paused) {
              ws.paused = false;
              try {
                ws._socket.resume();
              } catch {
                // ignore
              }
            }
          }
        }, 100);
      }
    });
  }

  endSession(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.watchdog) clearTimeout(s.watchdog);
    this.sessions.delete(sessionId);
    this.busyDevices.delete(s.a);
    this.busyDevices.delete(s.b);
    this.broadcastOnline();
    this.db
      .prepare("UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?")
      .run(nowIso(), sessionId);
    const staged = this.db
      .prepare("SELECT id FROM files WHERE scope = 'p2p' AND ref_id = ? AND status = 'active'")
      .all(sessionId);
    for (const f of staged) this.service.deleteFile(f.id, 'session_destroyed');
  }

  onClose(ws) {
    clearTimeout(ws.helloTimer);
    if (!ws.handshaken) return;
    const info = this.clients.get(ws);
    if (!info) return;
    this.clients.delete(ws);
    if (this.byDevice.get(info.deviceKey) === ws) this.byDevice.delete(info.deviceKey);
    if (this.byUserId.get(ws.user.id) === ws) this.byUserId.delete(ws.user.id);
    if (info.identityKey && this.byIdentity.get(info.identityKey) === ws) {
      this.byIdentity.delete(info.identityKey);
    }
    // 结束该设备参与的所有会话并通知对方
    for (const [sid, s] of this.sessions) {
      if (s.a !== info.deviceKey && s.b !== info.deviceKey) continue;
      const peer = s.a === info.deviceKey ? s.b : s.a;
      this.endSession(sid);
      this.sendTo(peer, { type: 'peerOffline', sessionId: sid });
    }
    this.busyDevices.delete(info.deviceKey);
    // 该用户没有其他在线连接时，从在线集合移除
    let stillOnline = false;
    for (const [, c] of this.clients) {
      if (c.user.id === ws.user.id) {
        stillOnline = true;
        break;
      }
    }
    if (!stillOnline) this.hub.online.delete(ws.user.id);
    this.broadcastOnline();
  }

  dispatchSessionEvent(sessionId, msg) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    for (const key of [s.a, s.b]) this.sendTo(key, { ...msg, sessionId });
  }

  dispatchRoomEvent(number, msg) {
    for (const [ws, info] of this.clients) {
      if (info.rooms.has(number)) this.send(ws, { ...msg, number });
    }
  }

  dispatchGlobalEvent(msg) {
    if (msg.type === 'kickUser' || msg.type === 'roomKicked' || msg.type === 'kickDevice') return;
    for (const [ws] of this.clients) this.send(ws, msg);
  }

  startHeartbeat() {
    const interval = setInterval(() => {
      const now = Date.now();
      for (const [ws] of this.clients) {
        const timeout = ws.filePick ? 300000 : this.cfg.heartbeatTimeoutMs;
        if (now - (ws.lastPong || now) > timeout) {
          ws.terminate();
          continue;
        }
        ws.ping();
      }
    }, this.cfg.heartbeatIntervalMs);
    interval.unref?.();
  }
}
