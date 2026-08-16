import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webdrop-test-'));
const PORT = 18080 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

let proc;
async function j(p, o = {}) {
  const headers = { 'content-type': 'application/json', ...(o.headers || {}) };
  const r = await fetch(BASE + p, {
    method: o.method || (o.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await r.text();
  let d;
  try { d = JSON.parse(text); } catch { d = text; }
  return { status: r.status, d };
}

test.before(async () => {
  proc = spawn(process.execPath, ['src/index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      WEBDROP_PORT: String(PORT),
      WEBDROP_DATA_DIR: path.join(tmp, 'data'),
      WEBDROP_STORAGE_PATH: path.join(tmp, 'files'),
      WEBDROP_DB_PATH: path.join(tmp, 'webdrop.sqlite'),
    },
    stdio: 'pipe',
  });
  let err = '';
  proc.stderr.on('data', (d) => (err += d));
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务启动失败: ' + err.slice(-500));
});

test.after(() => {
  proc?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('健康检查', async () => {
  const r = await j('/api/health');
  assert.equal(r.status, 200);
});

test('管理员默认账号登录 → 强制改密 → 直进管理台', async () => {
  let r = await j('/api/auth/login', { body: { username: 'admin', password: 'admin' } });
  assert.equal(r.status, 200);
  assert.equal(r.d.user.mustChange, true);
  const at = r.d.token;
  r = await j('/api/auth/change-password', {
    method: 'POST',
    body: { newUsername: 'boss', newPassword: 'boss123' },
    headers: { authorization: `Bearer ${at}` },
  });
  assert.equal(r.status, 200);
  r = await j('/api/auth/login', { body: { username: 'boss', password: 'boss123' } });
  assert.equal(r.status, 200);
  assert.equal(r.d.user.mustChange, false);
  r = await j('/api/admin/monitor', { headers: { authorization: `Bearer ${r.d.token}` } });
  assert.equal(r.status, 200);
  assert.ok(typeof r.d.cpu === 'number');
  assert.ok(r.d.project.total >= 0);
  // 普通用户不能访问管理接口
  const bad = await j('/api/admin/monitor');
  assert.equal(bad.status, 403);
});

test('注册审核流程与用户名唯一性', async () => {
  const admin = await j('/api/auth/login', { body: { username: 'boss', password: 'boss123' } });
  const at = admin.d.token;
  // 用户名不能与管理员重复
  let r = await j('/api/auth/register', { body: { username: 'boss', password: 'x1', email: 'a@b.c' } });
  assert.equal(r.status, 409);
  // 缺邮箱和 QQ
  r = await j('/api/auth/register', { body: { username: 'u1', password: 'x1' } });
  assert.equal(r.status, 400);
  // 正常注册
  r = await j('/api/auth/register', { body: { username: 'u1', password: 'pw1', email: 'u1@x.com', nickname: '一号' } });
  assert.equal(r.status, 201);
  assert.equal(r.d.pending, true);
  // 待审核不能登录
  r = await j('/api/auth/login', { body: { username: 'u1', password: 'pw1' } });
  assert.equal(r.status, 403);
  assert.match(r.d.error, /待审核/);
  // 管理员审批
  let ap = await j('/api/admin/approvals', { headers: { authorization: `Bearer ${at}` } });
  assert.equal(ap.d.registrations.length, 1);
  r = await j(`/api/admin/approvals/registrations/${ap.d.registrations[0].id}`, {
    body: { action: 'approve' },
    headers: { authorization: `Bearer ${at}` },
  });
  assert.equal(r.status, 200);
  r = await j('/api/auth/login', { body: { username: 'u1', password: 'pw1' } });
  assert.equal(r.status, 200);
  assert.equal(r.d.user.level, 0);
});

test('房间：随机开房、等级配额、自定义房间号审批', async () => {
  const admin = await j('/api/auth/login', { body: { username: 'boss', password: 'boss123' } });
  const at = admin.d.token;
  const u = await j('/api/auth/login', { body: { username: 'u1', password: 'pw1' } });
  const ut = u.d.token;
  // V0 开 1 个随机房间
  let r = await j('/api/rooms', { body: { mode: 'random' }, headers: { authorization: `Bearer ${ut}` } });
  assert.equal(r.status, 201);
  assert.equal(r.d.pending, false);
  const num = r.d.room.number;
  // 超出配额
  r = await j('/api/rooms', { body: { mode: 'random' }, headers: { authorization: `Bearer ${ut}` } });
  assert.equal(r.status, 403);
  // 自定义房间号需审批
  r = await j('/api/rooms', {
    body: { mode: 'custom', customNumber: '测试房间123' },
    headers: { authorization: `Bearer ${ut}` },
  });
  assert.equal(r.status, 403); // 已超配额
  // 提升为 V1（2 个房间）后可创建自定义房间
  const users = await j('/api/admin/users?type=registered', { headers: { authorization: `Bearer ${at}` } });
  const u1 = users.d.users.find((x) => x.username === 'u1');
  await j(`/api/admin/users/${u1.id}/status`, { body: { status: 'normal', level: 1 }, headers: { authorization: `Bearer ${at}` } });
  r = await j('/api/rooms', {
    body: { mode: 'custom', customNumber: '测试房间123', title: '测试' },
    headers: { authorization: `Bearer ${ut}` },
  });
  assert.equal(r.status, 201);
  assert.equal(r.d.pending, true);
  // 待审批房间不可加入
  r = await j(`/api/rooms/${encodeURIComponent('测试房间123')}`);
  assert.equal(r.status, 403);
  // 审批通过
  let ap = await j('/api/admin/approvals', { headers: { authorization: `Bearer ${at}` } });
  assert.equal(ap.d.roomRequests.length, 1);
  r = await j(`/api/admin/approvals/rooms/${ap.d.roomRequests[0].id}`, {
    body: { action: 'approve' },
    headers: { authorization: `Bearer ${at}` },
  });
  assert.equal(r.status, 200);
  r = await j(`/api/rooms/${encodeURIComponent('测试房间123')}`);
  assert.equal(r.status, 200);
});

test('房间文件：上传、配额、下载、过期、删除', async () => {
  const u = await j('/api/auth/login', { body: { username: 'u1', password: 'pw1' } });
  const ut = u.d.token;
  const rooms = await j('/api/rooms/mine', { headers: { authorization: `Bearer ${ut}` } });
  const num = rooms.d.rooms.find((x) => x.status === 'active').number;
  const buf = Buffer.from('webdrop integration file '.repeat(100));
  let up = await fetch(`${BASE}/api/rooms/${num}/files`, {
    method: 'POST',
    headers: {
      'x-file-name': encodeURIComponent('报告.txt'),
      'x-file-mime': 'text/plain',
      'x-expires': 'permanent',
      authorization: `Bearer ${ut}`,
    },
    body: buf,
  });
  const ud = await up.json();
  assert.equal(up.status, 201);
  const fileId = ud.file.id;
  assert.equal(ud.file.size, buf.length);
  // 下载
  let dl = await fetch(`${BASE}/api/files/${fileId}/download`, { headers: { authorization: `Bearer ${ut}` } });
  assert.equal(dl.status, 200);
  assert.equal((await dl.arrayBuffer()).byteLength, buf.length);
  // 配额占用
  let me = await j('/api/auth/me', { headers: { authorization: `Bearer ${ut}` } });
  assert.equal(me.d.user.usedBytes, buf.length);
  // 过期文件不可下载
  const past = new Date(Date.now() - 1000).toISOString();
  up = await fetch(`${BASE}/api/rooms/${num}/files`, {
    method: 'POST',
    headers: {
      'x-file-name': encodeURIComponent('过期.txt'),
      'x-file-mime': 'text/plain',
      'x-expires': encodeURIComponent(past),
      authorization: `Bearer ${ut}`,
    },
    body: Buffer.from('expired'),
  });
  const exp = await up.json();
  dl = await fetch(`${BASE}/api/files/${exp.file.id}/download`, { headers: { authorization: `Bearer ${ut}` } });
  assert.equal(dl.status, 410);
  // 删除释放配额
  let del = await j(`/api/rooms/${num}/files/${fileId}`, { method: 'DELETE', headers: { authorization: `Bearer ${ut}` } });
  assert.equal(del.status, 200);
  me = await j('/api/auth/me', { headers: { authorization: `Bearer ${ut}` } });
  assert.equal(me.d.user.usedBytes, 7); // 只剩 'expired' 文件
});

test('管理台：文件列表与管理员删除', async () => {
  const admin = await j('/api/auth/login', { body: { username: 'boss', password: 'boss123' } });
  const at = admin.d.token;
  let r = await j('/api/admin/files?scope=room', { headers: { authorization: `Bearer ${at}` } });
  assert.equal(r.status, 200);
  const file = r.d.files.find((f) => f.filename === '过期.txt');
  assert.ok(file);
  r = await j(`/api/admin/files/${file.id}/delete`, { method: 'POST', body: {}, headers: { authorization: `Bearer ${at}` } });
  assert.equal(r.status, 200);
  r = await j('/api/admin/files?scope=room&status=deleted', { headers: { authorization: `Bearer ${at}` } });
  const gone = r.d.files.find((f) => f.filename === '过期.txt');
  assert.equal(gone.status, 'deleted');
  assert.equal(gone.deleteReasonText, '管理员删除');
});

test('用户管理：封禁、删除与用户名释放', async () => {
  const admin = await j('/api/auth/login', { body: { username: 'boss', password: 'boss123' } });
  const at = admin.d.token;
  // 注册第二个用户
  await j('/api/auth/register', { body: { username: 'u2', password: 'pw2', qq: '10001' } });
  let ap = await j('/api/admin/approvals', { headers: { authorization: `Bearer ${at}` } });
  await j(`/api/admin/approvals/registrations/${ap.d.registrations[0].id}`, { body: { action: 'approve' }, headers: { authorization: `Bearer ${at}` } });
  const u2 = await j('/api/auth/login', { body: { username: 'u2', password: 'pw2' } });
  const u2t = u2.d.token;
  // 封禁
  let users = await j('/api/admin/users?type=registered', { headers: { authorization: `Bearer ${at}` } });
  const u2row = users.d.users.find((x) => x.username === 'u2');
  await j(`/api/admin/users/${u2row.id}/status`, { body: { status: 'banned' }, headers: { authorization: `Bearer ${at}` } });
  let r = await j('/api/auth/login', { body: { username: 'u2', password: 'pw2' } });
  assert.equal(r.status, 403);
  assert.match(r.d.error, /封禁/);
  // 删除后用户名可重新注册
  await j(`/api/admin/users/${u2row.id}/status`, { body: { status: 'deleted' }, headers: { authorization: `Bearer ${at}` } });
  r = await j('/api/auth/register', { body: { username: 'u2', password: 'pw2new', email: 'u2@x.com' } });
  assert.equal(r.status, 201);
  // 临时用户仅可 正常/封禁/删除
  users = await j('/api/admin/users?type=temp', { headers: { authorization: `Bearer ${at}` } });
  if (users.d.users.length) {
    r = await j(`/api/admin/users/${users.d.users[0].id}/status`, { body: { status: 'normal', level: 3 }, headers: { authorization: `Bearer ${at}` } });
    assert.equal(r.status, 200);
  }
});

test('设置：全局最大上传大小生效', async () => {
  const admin = await j('/api/auth/login', { body: { username: 'boss', password: 'boss123' } });
  const at = admin.d.token;
  let r = await j('/api/admin/settings', { method: 'PUT', body: { maxUploadBytes: 1024 }, headers: { authorization: `Bearer ${at}` } });
  assert.equal(r.status, 200);
  const u = await j('/api/auth/login', { body: { username: 'u1', password: 'pw1' } });
  const rooms = await j('/api/rooms/mine', { headers: { authorization: `Bearer ${u.d.token}` } });
  const num = rooms.d.rooms.find((x) => x.status === 'active').number;
  const up = await fetch(`${BASE}/api/rooms/${num}/files`, {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('big.bin'), authorization: `Bearer ${u.d.token}` },
    body: Buffer.alloc(2048),
  });
  assert.equal(up.status, 413);
  // 恢复默认
  await j('/api/admin/settings', { method: 'PUT', body: { maxUploadBytes: 10 * 1024 ** 3 }, headers: { authorization: `Bearer ${at}` } });
});

test('管理员重置脚本', async () => {
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(process.execPath, ['scripts/reset-admin.js', 'admin', 'admin'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      WEBDROP_DATA_DIR: path.join(tmp, 'data'),
      WEBDROP_STORAGE_PATH: path.join(tmp, 'files'),
      WEBDROP_DB_PATH: path.join(tmp, 'webdrop.sqlite'),
    },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0);
  const r = await j('/api/auth/login', { body: { username: 'admin', password: 'admin' } });
  assert.equal(r.status, 200);
  assert.equal(r.d.user.mustChange, true);
});

test('临时用户注销释放 UUID 并清理文件', async () => {
  const admin = await j('/api/auth/login', { body: { username: 'admin', password: 'admin' } });
  const at = admin.d.token;
  const u = await j('/api/auth/login', { body: { username: 'u1', password: 'pw1' } });
  const rooms = await j('/api/rooms/mine', { headers: { authorization: `Bearer ${u.d.token}` } });
  const num = rooms.d.rooms.find((x) => x.status === 'active').number;
  const tempId = 'TTT-LOGOUT-001';
  await j(`/api/rooms/${num}/join`, { method: 'POST', headers: { 'x-temp-id': tempId } });
  const up = await fetch(`${BASE}/api/rooms/${num}/files`, {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('临时.txt'), 'x-file-mime': 'text/plain', 'x-temp-id': tempId },
    body: Buffer.from('temp file'),
  });
  assert.equal(up.status, 201);
  const fileId = (await up.json()).file.id;
  // 注销
  let r = await j('/api/auth/temp-logout', { method: 'POST', headers: { 'x-temp-id': tempId } });
  assert.equal(r.status, 200);
  // 注销后仅清理 P2P 暂存文件，房间内文件保持可用（占用房主空间）
  const files = await j('/api/admin/files?scope=room', { headers: { authorization: `Bearer ${at}` } });
  const gone = files.d.files.find((f) => f.id === fileId);
  assert.equal(gone.status, 'active');
  // 同一 UUID 可再次获得新身份（不报错）
  r = await j(`/api/rooms/${num}/join`, { method: 'POST', headers: { 'x-temp-id': tempId } });
  assert.equal(r.status, 200);
});

test('房间密码、修改与历史房间', async () => {
  const admin = await j('/api/auth/login', { body: { username: 'admin', password: 'admin' } });
  const at = admin.d.token;
  // 注册并审批 u3
  await j('/api/auth/register', { body: { username: 'u3', password: 'pw3', email: 'u3@x.com' } });
  let ap = await j('/api/admin/approvals', { headers: { authorization: `Bearer ${at}` } });
  const reg = ap.d.registrations.find((x) => x.username === 'u3');
  await j(`/api/admin/approvals/registrations/${reg.id}`, { body: { action: 'approve' }, headers: { authorization: `Bearer ${at}` } });
  const u3 = await j('/api/auth/login', { body: { username: 'u3', password: 'pw3' } });
  const u3t = u3.d.token;
  // 创建带密码的房间
  let r = await j('/api/rooms', { body: { mode: 'random', title: '保密房间', password: 'secret123' }, headers: { authorization: `Bearer ${u3t}` } });
  assert.equal(r.status, 201);
  const num = r.d.room.number;
  assert.equal(r.d.room.hasPassword, true);
  // 错误/空密码不能加入
  r = await j(`/api/rooms/${num}/join`, { method: 'POST', body: { password: 'wrong' }, headers: { 'x-temp-id': 'PW-TEMP-01' } });
  assert.equal(r.status, 403);
  r = await j(`/api/rooms/${num}/join`, { method: 'POST', body: { password: '' }, headers: { 'x-temp-id': 'PW-TEMP-01' } });
  assert.equal(r.status, 403);
  // 正确密码加入成功
  r = await j(`/api/rooms/${num}/join`, { method: 'POST', body: { password: 'secret123' }, headers: { 'x-temp-id': 'PW-TEMP-01' } });
  assert.equal(r.status, 200);
  // 历史房间包含该房间
  r = await j('/api/rooms/history', { headers: { 'x-temp-id': 'PW-TEMP-01' } });
  assert.ok(r.d.rooms.some((x) => x.number === num));
  // 修改房间名和密码
  r = await j(`/api/rooms/${num}`, { method: 'PUT', body: { title: '改名房间', password: 'newpass' }, headers: { authorization: `Bearer ${u3t}` } });
  assert.equal(r.status, 200);
  assert.equal(r.d.room.title, '改名房间');
  assert.equal(r.d.room.hasPassword, true);
  // 旧密码失效、新密码可加入
  r = await j(`/api/rooms/${num}/join`, { method: 'POST', body: { password: 'secret123' }, headers: { 'x-temp-id': 'PW-TEMP-02' } });
  assert.equal(r.status, 403);
  r = await j(`/api/rooms/${num}/join`, { method: 'POST', body: { password: 'newpass' }, headers: { 'x-temp-id': 'PW-TEMP-02' } });
  assert.equal(r.status, 200);
  // 清除密码后无需密码即可加入
  r = await j(`/api/rooms/${num}`, { method: 'PUT', body: { title: '改名房间', password: '' }, headers: { authorization: `Bearer ${u3t}` } });
  assert.equal(r.d.room.hasPassword, false);
  r = await j(`/api/rooms/${num}/join`, { method: 'POST', body: { password: '' }, headers: { 'x-temp-id': 'PW-TEMP-03' } });
  assert.equal(r.status, 200);
  // 非房主不能修改
  const u1 = await j('/api/auth/login', { body: { username: 'u1', password: 'pw1' } });
  r = await j(`/api/rooms/${num}`, { method: 'PUT', body: { title: 'x' }, headers: { authorization: `Bearer ${u1.d.token}` } });
  assert.equal(r.status, 403);
  // 退出后仍在历史列表，但不能再发消息
  r = await j(`/api/rooms/${num}/leave`, { method: 'POST', headers: { 'x-temp-id': 'PW-TEMP-02' } });
  assert.equal(r.status, 200);
  r = await j('/api/rooms/history', { headers: { 'x-temp-id': 'PW-TEMP-02' } });
  assert.ok(r.d.rooms.some((x) => x.number === num));
  r = await j(`/api/rooms/${num}/messages`, { method: 'POST', body: { content: 'hi' }, headers: { 'x-temp-id': 'PW-TEMP-02' } });
  assert.equal(r.status, 403);
});

test('一键清理全部临时用户', async () => {
  const admin = await j('/api/auth/login', { body: { username: 'admin', password: 'admin' } });
  const at = admin.d.token;
  const before = await j('/api/admin/users?type=temp', { headers: { authorization: `Bearer ${at}` } });
  const activeBefore = before.d.users.filter((x) => x.status !== 'deleted').length;
  const r = await j('/api/admin/users/temp-clear', { method: 'POST', body: {}, headers: { authorization: `Bearer ${at}` } });
  assert.equal(r.status, 200);
  assert.equal(r.d.count, activeBefore);
  const after = await j('/api/admin/users?type=temp', { headers: { authorization: `Bearer ${at}` } });
  assert.ok(after.d.users.every((x) => x.status === 'deleted'));
});

test('房间上传占用房主空间与房主限制', async () => {
  const admin = await j('/api/auth/login', { body: { username: 'admin', password: 'admin' } });
  const at = admin.d.token;
  const u3 = await j('/api/auth/login', { body: { username: 'u3', password: 'pw3' } });
  const u3t = u3.d.token;
  const rooms = await j('/api/rooms/mine', { headers: { authorization: `Bearer ${u3t}` } });
  const num = rooms.d.rooms[0].number;
  const before = await j('/api/auth/me', { headers: { authorization: `Bearer ${u3t}` } });
  await j(`/api/rooms/${num}/join`, { method: 'POST', headers: { 'x-temp-id': 'OWN-TEMP-01' } });
  // 临时用户上传 → 占用房主（u3）空间
  const up = await fetch(`${BASE}/api/rooms/${num}/files`, {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('owner-space.txt'), 'x-temp-id': 'OWN-TEMP-01' },
    body: Buffer.alloc(2048, 1),
  });
  assert.equal(up.status, 201);
  const after = await j('/api/auth/me', { headers: { authorization: `Bearer ${u3t}` } });
  assert.equal(after.d.user.usedBytes - before.d.user.usedBytes, 2048);
  // 房主设置单文件上限 1MB 与最长保存 1 天
  let r = await j(`/api/rooms/${num}`, {
    method: 'PUT',
    body: { maxFileSize: 1024 * 1024, maxRetentionDays: 1 },
    headers: { authorization: `Bearer ${u3t}` },
  });
  assert.equal(r.status, 200);
  // 超过单文件上限被拒
  await j(`/api/rooms/${num}/join`, { method: 'POST', headers: { 'x-temp-id': 'OWN-TEMP-02' } });
  const big = await fetch(`${BASE}/api/rooms/${num}/files`, {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('too-big.bin'), 'x-temp-id': 'OWN-TEMP-02' },
    body: Buffer.alloc(2 * 1024 * 1024),
  });
  assert.equal(big.status, 413);
  // 选择永久保存也会被房主限制截断到 1 天
  const exp = await fetch(`${BASE}/api/rooms/${num}/files`, {
    method: 'POST',
    headers: {
      'x-file-name': encodeURIComponent('capped.bin'),
      'x-expires': encodeURIComponent('permanent'),
      'x-temp-id': 'OWN-TEMP-02',
    },
    body: Buffer.alloc(100),
  });
  const expd = await exp.json();
  assert.equal(exp.status, 201);
  const cap = Date.parse(new Date(Date.now() + 86400e3).toISOString());
  assert.ok(Date.parse(expd.file.expiresAt) <= cap + 1000);
  // 房主自己上传不受保留期限制（选择永久则不过期）
  const ownUp = await fetch(`${BASE}/api/rooms/${num}/files`, {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('owner-own.bin'), 'x-expires': encodeURIComponent('permanent'), authorization: `Bearer ${u3t}` },
    body: Buffer.alloc(50),
  });
  const ownUpd = await ownUp.json();
  assert.equal(ownUp.status, 201);
  assert.equal(ownUpd.file.expiresAt, null);
  // 房间总容量限制：只允许再放 200 字节
  let files = await j(`/api/rooms/${num}/files`);
  const used = files.d.files.filter((f) => f.status === 'active').reduce((s, f) => s + f.size, 0);
  await j(`/api/rooms/${num}`, { method: 'PUT', body: { roomCapacityBytes: used + 200 }, headers: { authorization: `Bearer ${u3t}` } });
  await j(`/api/rooms/${num}/join`, { method: 'POST', headers: { 'x-temp-id': 'OWN-TEMP-03' } });
  const okCap = await fetch(`${BASE}/api/rooms/${num}/files`, {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('cap-ok.bin'), 'x-temp-id': 'OWN-TEMP-03' },
    body: Buffer.alloc(100),
  });
  assert.equal(okCap.status, 201);
  const overCap = await fetch(`${BASE}/api/rooms/${num}/files`, {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('cap-over.bin'), 'x-temp-id': 'OWN-TEMP-03' },
    body: Buffer.alloc(200),
  });
  assert.equal(overCap.status, 403);
  await j(`/api/rooms/${num}`, { method: 'PUT', body: { roomCapacityBytes: null }, headers: { authorization: `Bearer ${u3t}` } });
  // 上传者注销不影响房间文件
  await j('/api/auth/temp-logout', { method: 'POST', headers: { 'x-temp-id': 'OWN-TEMP-02' } });
  files = await j('/api/admin/files?scope=room', { headers: { authorization: `Bearer ${at}` } });
  const capped = files.d.files.find((f) => f.filename === 'capped.bin');
  assert.equal(capped.status, 'active');
});

test('房主踢出与拉黑成员', async () => {
  const admin = await j('/api/auth/login', { body: { username: 'admin', password: 'admin' } });
  const at = admin.d.token;
  const u3 = await j('/api/auth/login', { body: { username: 'u3', password: 'pw3' } });
  const u3t = u3.d.token;
  const rooms = await j('/api/rooms/mine', { headers: { authorization: `Bearer ${u3t}` } });
  const num = rooms.d.rooms[0].number;
  const tempId = 'KICK-TEMP-01';
  await j(`/api/rooms/${num}/join`, { method: 'POST', headers: { 'x-temp-id': tempId } });
  // 房主踢出
  // 成员列表仅显示在线成员（REST 加入的临时用户不在线），通过管理端用户列表获取其 id
  let users = await j('/api/admin/users?type=temp', { headers: { authorization: `Bearer ${at}` } });
  const target = users.d.users.find((u) => u.uuid === tempId);
  assert.ok(target);
  let r = await j(`/api/rooms/${num}/members/${target.id}/kick`, { method: 'POST', body: {}, headers: { authorization: `Bearer ${u3t}` } });
  assert.equal(r.status, 200);
  // 被踢后不能发消息，但可重新加入
  r = await j(`/api/rooms/${num}/messages`, { method: 'POST', body: { content: 'hi' }, headers: { 'x-temp-id': tempId } });
  assert.equal(r.status, 403);
  r = await j(`/api/rooms/${num}/join`, { method: 'POST', headers: { 'x-temp-id': tempId } });
  assert.equal(r.status, 200);
  // 拉黑后不能加入
  r = await j(`/api/rooms/${num}/members/${target.id}/blacklist`, { method: 'POST', body: {}, headers: { authorization: `Bearer ${u3t}` } });
  assert.equal(r.status, 200);
  r = await j(`/api/rooms/${num}/join`, { method: 'POST', headers: { 'x-temp-id': tempId } });
  assert.equal(r.status, 403);
  assert.match(r.d.error, /拉黑/);
  // 黑名单列表 + 解除后恢复
  let bl = await j(`/api/rooms/${num}/blacklist`, { headers: { authorization: `Bearer ${u3t}` } });
  assert.ok(bl.d.users.some((x) => x.id === target.id));
  r = await j(`/api/rooms/${num}/blacklist/${target.id}/unban`, { method: 'POST', body: {}, headers: { authorization: `Bearer ${u3t}` } });
  assert.equal(r.status, 200);
  r = await j(`/api/rooms/${num}/join`, { method: 'POST', headers: { 'x-temp-id': tempId } });
  assert.equal(r.status, 200);
});

test('管理端房间列表与设置', async () => {
  const admin = await j('/api/auth/login', { body: { username: 'admin', password: 'admin' } });
  const at = admin.d.token;
  const r = await j('/api/admin/rooms', { headers: { authorization: `Bearer ${at}` } });
  assert.equal(r.status, 200);
  const room = r.d.rooms.find((x) => x.number === r.d.rooms[0].number);
  assert.ok(room);
  assert.ok('maxRetentionDays' in room && 'maxFileSize' in room && 'hasPassword' in room);
  // 管理员可修改房间设置
  const u3 = await j('/api/auth/login', { body: { username: 'u3', password: 'pw3' } });
  const rooms = await j('/api/rooms/mine', { headers: { authorization: `Bearer ${u3.d.token}` } });
  const num = rooms.d.rooms[0].number;
  const put = await j(`/api/rooms/${num}`, {
    method: 'PUT',
    body: { title: '管理员改的名', maxRetentionDays: 7, maxFileSize: 5 * 1024 ** 3, roomCapacityBytes: 10 * 1024 ** 3 },
    headers: { authorization: `Bearer ${at}` },
  });
  assert.equal(put.status, 200);
  assert.equal(put.d.room.title, '管理员改的名');
  assert.equal(put.d.room.maxRetentionDays, 7);
  assert.equal(put.d.room.maxFileSize, 5 * 1024 ** 3);
  assert.equal(put.d.room.roomCapacityBytes, 10 * 1024 ** 3);
});

test('个人资料修改与设备管理', async () => {
  const admin = await j('/api/auth/login', { body: { username: 'admin', password: 'admin' } });
  const at = admin.d.token;
  await j('/api/auth/register', { body: { username: 'u4', password: 'pw4', email: 'u4@x.com' } });
  let ap = await j('/api/admin/approvals', { headers: { authorization: `Bearer ${at}` } });
  const reg = ap.d.registrations.find((x) => x.username === 'u4');
  await j(`/api/admin/approvals/registrations/${reg.id}`, { method: 'POST', body: { action: 'approve' }, headers: { authorization: `Bearer ${at}` } });
  let u = await j('/api/auth/login', { method: 'POST', body: { username: 'u4', password: 'pw4', deviceId: 'DEVICE-AAAA' } });
  const ut = u.d.token;
  let me = await j('/api/auth/me', { headers: { authorization: `Bearer ${ut}` } });
  const uuid = me.d.user.uuid;
  assert.ok(uuid);
  // 修改用户名/昵称/密码，UUID 不变
  let r = await j('/api/auth/update-profile', {
    method: 'POST',
    body: { username: 'u4new', nickname: '昵称四', currentPassword: 'pw4', newPassword: 'pw4new' },
    headers: { authorization: `Bearer ${ut}` },
  });
  assert.equal(r.status, 200);
  assert.equal(r.d.user.username, 'u4new');
  assert.equal(r.d.user.uuid, uuid);
  // 旧密码失效、新密码可登录
  r = await j('/api/auth/login', { body: { username: 'u4new', password: 'pw4' } });
  assert.equal(r.status, 401);
  r = await j('/api/auth/login', { body: { username: 'u4new', password: 'pw4new' } });
  assert.equal(r.status, 200);
  const ut2 = r.d.token;
  // 用户名冲突
  r = await j('/api/auth/update-profile', {
    method: 'POST',
    body: { username: 'u3', currentPassword: 'pw4new' },
    headers: { authorization: `Bearer ${ut2}` },
  });
  assert.equal(r.status, 409);
  // 拉黑设备后该设备无法登录
  r = await j('/api/auth/devices/DEVICE-BBBB/blacklist', { method: 'POST', body: {}, headers: { authorization: `Bearer ${ut2}` } });
  assert.equal(r.status, 200);
  r = await j('/api/auth/login', { method: 'POST', body: { username: 'u4new', password: 'pw4new', deviceId: 'DEVICE-BBBB' } });
  assert.equal(r.status, 403);
  // 解除拉黑后恢复
  r = await j('/api/auth/devices/DEVICE-BBBB/unblacklist', { method: 'POST', body: {}, headers: { authorization: `Bearer ${ut2}` } });
  assert.equal(r.status, 200);
  r = await j('/api/auth/login', { method: 'POST', body: { username: 'u4new', password: 'pw4new', deviceId: 'DEVICE-BBBB' } });
  assert.equal(r.status, 200);
  // 设备下线：该设备 token 立即失效
  const dlogin = await j('/api/auth/login', { method: 'POST', body: { username: 'u4new', password: 'pw4new', deviceId: 'DEVICE-CCCC' } });
  await j('/api/auth/devices/DEVICE-CCCC/logout', { method: 'POST', body: {}, headers: { authorization: `Bearer ${ut2}` } });
  const me2 = await j('/api/auth/me', { headers: { authorization: `Bearer ${dlogin.d.token}` } });
  assert.equal(me2.status, 401);
});

test('管理员改密可留空', async () => {
  let admin = await j('/api/auth/login', { body: { username: 'admin', password: 'admin' } });
  const at = admin.d.token;
  // 仅验证当前密码、不修改任何字段 → 成功
  let r = await j('/api/admin/change-credentials', {
    method: 'POST',
    body: { currentPassword: 'admin' },
    headers: { authorization: `Bearer ${at}` },
  });
  assert.equal(r.status, 200);
  // 改用户名但密码留空 → 密码保持不变
  r = await j('/api/admin/change-credentials', {
    method: 'POST',
    body: { currentPassword: 'admin', newUsername: 'admin2' },
    headers: { authorization: `Bearer ${at}` },
  });
  assert.equal(r.status, 200);
  r = await j('/api/auth/login', { body: { username: 'admin2', password: 'admin' } });
  assert.equal(r.status, 200);
});

test('主题包：列表、上传、删除、模板与全局主题', async () => {
  const JSZip = (await import('jszip')).default;
  const mkZip = async (name, accent) => {
    const zip = new JSZip();
    zip.file('theme.json', JSON.stringify({ name, version: '1.0.0', author: 'tester', description: '集成测试主题' }));
    zip.file('theme.css', `:root { --accent: ${accent}; }\n`);
    return zip.generateAsync({ type: 'nodebuffer' });
  };
  // 临时用户仅见默认主题
  let r = await j('/api/themes', { headers: { 'x-temp-id': 'THEME-IT' } });
  assert.equal(r.status, 200);
  assert.equal(r.d.themes.length, 1);
  assert.equal(r.d.themes[0].name, 'default');
  // 管理员下载模板
  const admin = await j('/api/auth/login', { body: { username: 'admin2', password: 'admin' } });
  const at = admin.d.token;
  const tpl = await fetch(`${BASE}/api/admin/themes/template`, { headers: { authorization: `Bearer ${at}` } });
  assert.equal(tpl.status, 200);
  const tplZip = await JSZip.loadAsync(Buffer.from(await tpl.arrayBuffer()));
  assert.ok(tplZip.file('theme.json') && tplZip.file('theme.css'));
  // 默认主题不可删除
  r = await j('/api/admin/themes/default', { method: 'DELETE', headers: { authorization: `Bearer ${at}` } });
  assert.equal(r.status, 403);
  // 管理员上传/删除公共主题
  let up = await fetch(`${BASE}/api/admin/themes/upload`, { method: 'POST', headers: { authorization: `Bearer ${at}` }, body: await mkZip('pubtest', '#112233') });
  assert.equal(up.status, 201);
  r = await j('/api/themes', { headers: { 'x-temp-id': 'THEME-IT' } });
  assert.ok(r.d.themes.some((t) => t.name === 'pubtest' && t.source === 'public'));
  // 注册用户上传个人主题并删除
  await j('/api/auth/register', { method: 'POST', body: { username: 'u10', password: 'pw10', email: 'u10@x.com' } });
  let ap = await j('/api/admin/approvals', { headers: { authorization: `Bearer ${at}` } });
  const u10reg = ap.d.registrations.find((x) => x.username === 'u10');
  await j(`/api/admin/approvals/registrations/${u10reg.id}`, { method: 'POST', body: { action: 'approve' }, headers: { authorization: `Bearer ${at}` } });
  const u10 = await j('/api/auth/login', { method: 'POST', body: { username: 'u10', password: 'pw10' } });
  up = await fetch(`${BASE}/api/themes/upload`, { method: 'POST', headers: { authorization: `Bearer ${u10.d.token}` }, body: await mkZip('mypub', '#ff00ff') });
  assert.equal(up.status, 201);
  r = await j('/api/themes', { headers: { authorization: `Bearer ${u10.d.token}` } });
  const mine = r.d.themes.find((t) => t.name === 'mypub');
  assert.equal(mine.source, 'user');
  assert.equal(mine.deletable, true);
  r = await j('/api/themes/mypub', { method: 'DELETE', headers: { authorization: `Bearer ${u10.d.token}` } });
  assert.equal(r.status, 200);
  // 公共主题普通用户不可删除
  r = await j('/api/themes/pubtest', { method: 'DELETE', headers: { authorization: `Bearer ${u10.d.token}` } });
  assert.equal(r.status, 404); // 个人删除接口只查个人目录
  // 全局主题设置
  r = await j('/api/admin/themes/global', { method: 'POST', body: { theme: 'public:pubtest' }, headers: { authorization: `Bearer ${at}` } });
  assert.equal(r.status, 200);
  const g = await j('/api/themes/global');
  assert.equal(g.d.theme, 'public:pubtest');
  // 管理员删除公共主题
  r = await j('/api/admin/themes/pubtest', { method: 'DELETE', headers: { authorization: `Bearer ${at}` } });
  assert.equal(r.status, 200);
});

test('房间上传/下载权限', async () => {
  const admin = await j('/api/auth/login', { body: { username: 'admin2', password: 'admin' } });
  const at = admin.d.token;
  const u3 = await j('/api/auth/login', { body: { username: 'u3', password: 'pw3' } });
  const u3t = u3.d.token;
  const rooms = await j('/api/rooms/mine', { headers: { authorization: `Bearer ${u3t}` } });
  const num = rooms.d.rooms[0].number;
  const u1 = await j('/api/auth/login', { body: { username: 'u1', password: 'pw1' } });
  await j(`/api/rooms/${num}/join`, { method: 'POST', headers: { authorization: `Bearer ${u1.d.token}` } });
  await j(`/api/rooms/${num}/join`, { method: 'POST', headers: { 'x-temp-id': 'PERM-T' } });

  // 仅自己上传：临时用户被拒
  let r = await j(`/api/rooms/${num}`, { method: 'PUT', body: { uploadPermission: 'owner' }, headers: { authorization: `Bearer ${u3t}` } });
  assert.equal(r.status, 200);
  let up = await fetch(`${BASE}/api/rooms/${num}/files`, {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('p1.txt'), 'x-temp-id': 'PERM-T' },
    body: Buffer.from('x'),
  });
  assert.equal(up.status, 403);
  // 仅登录用户上传：临时用户被拒、注册用户可传
  await j(`/api/rooms/${num}`, { method: 'PUT', body: { uploadPermission: 'registered' }, headers: { authorization: `Bearer ${u3t}` } });
  up = await fetch(`${BASE}/api/rooms/${num}/files`, {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('p2.txt'), 'x-temp-id': 'PERM-T' },
    body: Buffer.from('y'),
  });
  assert.equal(up.status, 403);
  up = await fetch(`${BASE}/api/rooms/${num}/files`, {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('p3.txt'), authorization: `Bearer ${u1.d.token}` },
    body: Buffer.from('z'),
  });
  assert.equal(up.status, 201);
  const fileId = (await up.json()).file.id;
  // 仅自己下载：临时用户被拒、房主可下载
  await j(`/api/rooms/${num}`, { method: 'PUT', body: { downloadPermission: 'owner' }, headers: { authorization: `Bearer ${u3t}` } });
  let dl = await fetch(`${BASE}/api/files/${fileId}/download`, { headers: { 'x-temp-id': 'PERM-T' } });
  assert.equal(dl.status, 403);
  dl = await fetch(`${BASE}/api/files/${fileId}/download`, { headers: { authorization: `Bearer ${u3t}` } });
  assert.equal(dl.status, 200);
  // 仅登录用户下载：临时用户被拒、注册成员可下载
  await j(`/api/rooms/${num}`, { method: 'PUT', body: { downloadPermission: 'registered' }, headers: { authorization: `Bearer ${u3t}` } });
  dl = await fetch(`${BASE}/api/files/${fileId}/download`, { headers: { 'x-temp-id': 'PERM-T' } });
  assert.equal(dl.status, 403);
  dl = await fetch(`${BASE}/api/files/${fileId}/download`, { headers: { authorization: `Bearer ${u1.d.token}` } });
  assert.equal(dl.status, 200);
  // 恢复为所有人
  await j(`/api/rooms/${num}`, { method: 'PUT', body: { uploadPermission: 'all', downloadPermission: 'all' }, headers: { authorization: `Bearer ${u3t}` } });
  dl = await fetch(`${BASE}/api/files/${fileId}/download`, { headers: { 'x-temp-id': 'PERM-T' } });
  assert.equal(dl.status, 200);
});
