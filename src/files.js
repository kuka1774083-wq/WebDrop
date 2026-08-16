import fs from 'node:fs';
import { Router, sendJson, decodeHeader } from './http.js';
import { nowIso, displayNameFor } from './util.js';

export function fileRoutes({ db, cfg, service, hub }) {
  const r = new Router();

  function accessAllowed(file, req, user) {
    if (file.status === 'deleted') return { ok: false, code: 410, error: '文件已删除' };
    if (file.expires_at && Date.parse(file.expires_at) <= Date.now()) {
      return { ok: false, code: 410, error: '文件已过期' };
    }
    let allowed = user?.role === 'admin';
    if (file.scope === 'p2p') {
      const token = req.query.get('token');
      allowed =
        allowed ||
        (token && file.access_token && token === file.access_token) ||
        (user && service.isSessionParticipant(file.ref_id, user.id));
    } else if (file.scope === 'room') {
      allowed = allowed || (user && service.isRoomMember(Number(file.ref_id), user.id));
      if (allowed && user && user.role !== 'admin') {
        const room = db
          .prepare('SELECT owner_id, download_permission FROM rooms WHERE id = ?')
          .get(file.ref_id);
        if (room) {
          const perm = room.download_permission || 'all';
          if (perm === 'owner' && user.id !== room.owner_id) allowed = false;
          if (perm === 'registered' && user.role !== 'registered') allowed = false;
        }
      }
    }
    if (!allowed) return { ok: false, code: 403, error: '无权访问' };
    return { ok: true };
  }

  function serveFile(res, file, req, sub) {
    const target = sub === 'thumb' ? file.thumb_path : sub === 'preview' ? file.preview_path : file.path;
    if (!target || !fs.existsSync(target)) {
      return sendJson(res, 404, { error: '文件缺失' });
    }
    const st = fs.statSync(target);
    const mime = sub === 'thumb' ? 'image/jpeg' : sub === 'preview' ? 'video/mp4' : file.mime || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (Number.isNaN(start)) start = 0;
        if (end >= st.size) end = st.size - 1;
        if (start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          return res.end();
        }
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        });
        return fs.createReadStream(target, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(target).pipe(res);
  }

  r.post('/api/staging/upload', async (req, res) => {
    const user = service.identify(req);
    const sessionId = req.query.get('session') || decodeHeader(req.headers['x-session']);
    if (!user || !sessionId) return sendJson(res, 401, { error: '身份无效' });
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!session || session.status !== 'active') {
      return sendJson(res, 410, { error: '会话不存在或已结束' });
    }
    if (!service.isSessionParticipant(sessionId, user.id)) {
      return sendJson(res, 403, { error: '不是会话成员' });
    }
    const filename = decodeHeader(req.headers['x-file-name']);
    const mime = decodeHeader(req.headers['x-file-mime']) || 'application/octet-stream';
    const size = Number(req.headers['content-length'] || 0);
    if (!filename) return sendJson(res, 400, { error: '缺少文件名' });
    const file = await service.uploadStagingFile({ session, user, filename, mime, size, req });
    const msg = service.addMessage({
      scope: 'p2p',
      refId: session.id,
      senderId: user.id,
      senderName: displayNameFor(user, []),
      type: file.kind === 'voice' ? 'voice' : file.kind === 'image' ? 'image' : file.kind === 'video' ? 'video' : 'file',
      content: file.filename,
      fileId: file.id,
    });
    hub.emitSession(session.id, { type: 'stagedFile', file: service.publicFile(file), message: msg });
    sendJson(res, 201, { file: service.publicFile(file), message: msg });
  });

  r.get('/api/files/:id/download', async (req, res) => {
    const file = service.getFile(req.params.id);
    if (!file) return sendJson(res, 404, { error: '文件不存在' });
    const user = service.identify(req);
    const check = accessAllowed(file, req, user);
    if (!check.ok) return sendJson(res, check.code, { error: check.error });
    if (!file.path || !fs.existsSync(file.path)) {
      return sendJson(res, 404, { error: '文件缺失' });
    }
    const st = fs.statSync(file.path);
    const inline = ['image', 'video', 'voice'].includes(file.kind);
    const disp = inline ? 'inline' : 'attachment';
    const name = encodeURIComponent(file.filename);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (Number.isNaN(start)) start = 0;
        if (end >= st.size) end = st.size - 1;
        if (start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          return res.end();
        }
        res.writeHead(206, {
          'Content-Type': file.mime || 'application/octet-stream',
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': `${disp}; filename*=UTF-8''${name}`,
        });
        return fs.createReadStream(file.path, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, {
      'Content-Type': file.mime || 'application/octet-stream',
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `${disp}; filename*=UTF-8''${name}`,
    });
    fs.createReadStream(file.path).pipe(res);
  });

  r.get('/api/files/:id/thumb', async (req, res) => {
    const file = service.getFile(req.params.id);
    if (!file) return sendJson(res, 404, { error: '文件不存在' });
    const user = service.identify(req);
    const check = accessAllowed(file, req, user);
    if (!check.ok) return sendJson(res, check.code, { error: check.error });
    serveFile(res, file, req, 'thumb');
  });

  r.get('/api/files/:id/preview', async (req, res) => {
    const file = service.getFile(req.params.id);
    if (!file) return sendJson(res, 404, { error: '文件不存在' });
    const user = service.identify(req);
    const check = accessAllowed(file, req, user);
    if (!check.ok) return sendJson(res, check.code, { error: check.error });
    serveFile(res, file, req, 'preview');
  });

  // P2P 会话消息补拉：返回 after 之后的新消息（选文件期间/断线重连后回到聊天时同步）
  r.get('/api/sessions/:id/messages', async (req, res) => {
    const user = service.identify(req);
    if (!user) return sendJson(res, 401, { error: '身份无效' });
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!session || session.status !== 'active') return sendJson(res, 410, { error: '会话不存在或已结束' });
    if (!service.isSessionParticipant(session.id, user.id)) {
      return sendJson(res, 403, { error: '不是会话成员' });
    }
    const after = Number(req.query.get('after') || 0);
    const rows = db
      .prepare("SELECT * FROM messages WHERE scope = 'p2p' AND ref_id = ? AND id > ? ORDER BY id ASC")
      .all(session.id, after);
    sendJson(res, 200, { messages: rows });
  });

  return r;
}
