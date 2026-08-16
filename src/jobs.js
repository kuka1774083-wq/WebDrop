import { nowIso } from './util.js';
import { destroyRoom } from './rooms.js';
import { removeUserThemes } from './themes.js';

export function startJobs({ db, cfg, service, hub }) {
  const run = () => {
    try {
      expireFiles();
      destroyRooms();
      cleanupStaging();
      tempUserCleanup();
    } catch (e) {
      console.error('[job]', e);
    }
  };

  function expireFiles() {
    const rows = db
      .prepare("SELECT * FROM files WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?")
      .all(nowIso());
    for (const f of rows) {
      service.deleteFile(f.id, 'auto_expired');
      if (f.scope === 'room') {
        const room = db.prepare('SELECT room_number FROM rooms WHERE id = ?').get(f.ref_id);
        if (room) hub.emitRoom(room.room_number, { type: 'roomFileDeleted', number: room.room_number, fileId: f.id });
      }
    }
  }

  function destroyRooms() {
    const rows = db
      .prepare("SELECT * FROM rooms WHERE status = 'active' AND destroy_at IS NOT NULL AND destroy_at <= ?")
      .all(nowIso());
    for (const room of rows) {
      destroyRoom(db, service, room);
      hub.emitRoom(room.room_number, { type: 'roomDestroyed', number: room.room_number });
    }
  }

  function cleanupStaging() {
    // 会话已结束但暂存文件未清理（如进程崩溃）
    const rows = db
      .prepare(
        `SELECT f.id FROM files f LEFT JOIN sessions s ON s.id = f.ref_id
         WHERE f.scope = 'p2p' AND f.status = 'active' AND (s.id IS NULL OR s.status != 'active')`
      )
      .all();
    for (const r of rows) service.deleteFile(r.id, 'session_destroyed');
  }

  function tempUserCleanup() {
    const cutoff = new Date(Date.now() - cfg.tempUserInactiveDays * 86400e3).toISOString();
    const rows = db
      .prepare(
        "SELECT id FROM users WHERE role = 'temp' AND status = 'normal' AND last_active_at < ?"
      )
      .all(cutoff);
    for (const u of rows) {
      service.deleteUserFiles(u.id, 'user_deleted');
      removeUserThemes(cfg.dataDir, u.uuid);
      db.prepare('UPDATE users SET username = NULL, used_bytes = 0, status = ? WHERE id = ?').run('deleted', u.id);
    }
  }

  run();
  const t = setInterval(run, cfg.jobIntervalMs || 60000);
  t.unref?.();
  return t;
}
