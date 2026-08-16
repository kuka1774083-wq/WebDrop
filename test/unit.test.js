import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBytes,
  genTempUuid,
  hashPassword,
  verifyPassword,
  isValidCustomRoomNumber,
  genRandomRoomNumber,
  genTempNickname,
  roomQuotaForLevel,
  quotaBytesForLevel,
  displayNameFor,
  deleteReasonLabel,
  kindForMime,
  safeFilename,
  expiresChoiceToIso,
} from '../src/util.js';
import {
  isPrivateIp,
  subnetOf,
  hasMatchingSubnet,
  parseCandidateIp,
} from '../public/js/rtc.js';

test('formatBytes 自动选择单位', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.00 GB');
  assert.equal(formatBytes(2 * 1024 ** 4), '2.00 TB');
});

test('临时用户 UUID 变长且唯一', () => {
  const ids = new Set(Array.from({ length: 200 }, () => genTempUuid()));
  assert.equal(ids.size, 200);
  for (const id of ids) {
    assert.ok(id.length >= 10 && id.length <= 16);
  }
});

test('临时用户趣味昵称生成且不重复', () => {
  const used = new Set(['可爱的桃子']);
  const n = genTempNickname(used);
  assert.ok(n.length >= 4);
  assert.ok(!used.has(n));
  const set = new Set();
  for (let i = 0; i < 500; i++) set.add(genTempNickname(set));
  assert.equal(set.size, 500);
});

test('密码哈希与校验', async () => {
  const h = await hashPassword('secret123');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(await verifyPassword('secret123', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(await verifyPassword('x', 'invalid'), false);
});

test('自定义房间号校验', () => {
  assert.equal(isValidCustomRoomNumber('123456'), true);
  assert.equal(isValidCustomRoomNumber('abcDEF'), true);
  assert.equal(isValidCustomRoomNumber('中文房间ABC'), true);
  assert.equal(isValidCustomRoomNumber('12345'), false);
  assert.equal(isValidCustomRoomNumber('1234567890123'), false);
  assert.equal(isValidCustomRoomNumber('abc!@#'), false);
  assert.equal(isValidCustomRoomNumber(''), false);
});

test('随机房间号 6 位且不重复', () => {
  const existing = new Set(['000001', '000002']);
  for (let i = 0; i < 50; i++) {
    const n = genRandomRoomNumber(existing);
    assert.match(n, /^\d{6}$/);
    assert.ok(!existing.has(n));
  }
});

test('会员等级房间配额', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(roomQuotaForLevel), [1, 2, 3, 4, 6, 8, 10]);
  assert.equal(roomQuotaForLevel(-1), 1);
  assert.equal(roomQuotaForLevel(99), 10);
});

test('持久存储 = 基准 + 等级 × 50G', () => {
  assert.equal(quotaBytesForLevel(100, 0), 100 * 1024 ** 3);
  assert.equal(quotaBytesForLevel(100, 1), 150 * 1024 ** 3);
  assert.equal(quotaBytesForLevel(100, 6), 400 * 1024 ** 3);
  assert.equal(quotaBytesForLevel(50, 2), 150 * 1024 ** 3);
});

test('昵称重名追加 UUID 后 4 位', () => {
  const a = { id: 1, nickname: '小明', uuid: 'ABCDEF123456' };
  const b = { id: 2, nickname: '小明', uuid: '000011112222' };
  assert.equal(displayNameFor(a, [a, b]), '小明#3456');
  assert.equal(displayNameFor(a, [a]), '小明');
  const t = { id: 3, uuid: 'X1Y2Z3' };
  assert.equal(displayNameFor(t, []), 'X1Y2Z3');
});

test('删除原因文案', () => {
  assert.equal(deleteReasonLabel('auto_expired'), '文件自动过期');
  assert.equal(deleteReasonLabel('unknown'), 'unknown');
});

test('mime 归类', () => {
  assert.equal(kindForMime('image/png'), 'image');
  assert.equal(kindForMime('video/mp4'), 'video');
  assert.equal(kindForMime('audio/mp4'), 'voice');
  assert.equal(kindForMime('application/pdf'), 'file');
});

test('文件名安全化', () => {
  assert.equal(safeFilename('a/b\\c.txt'), 'a_b_c.txt');
  assert.equal(safeFilename(''), 'file');
});

test('过期时间选项', () => {
  assert.equal(expiresChoiceToIso('permanent'), null);
  assert.ok(expiresChoiceToIso('h1') > new Date().toISOString());
  const custom = expiresChoiceToIso('2099-01-01T00:00:00.000Z');
  assert.equal(custom, '2099-01-01T00:00:00.000Z');
});

test('局域网 IP 识别', () => {
  assert.equal(isPrivateIp('192.168.1.23'), true);
  assert.equal(isPrivateIp('10.0.0.5'), true);
  assert.equal(isPrivateIp('172.16.4.9'), true);
  assert.equal(isPrivateIp('172.31.255.1'), true);
  assert.equal(isPrivateIp('172.32.1.1'), false);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('fd12:3456:789a::1'), true);
  assert.equal(isPrivateIp('2001:4860:4860::8888'), false);
  assert.equal(isPrivateIp(null), false);
});

test('子网标识与匹配', () => {
  assert.equal(subnetOf('192.168.1.23'), '192.168.1');
  assert.equal(subnetOf('10.0.0.5'), '10.0.0');
  assert.equal(subnetOf('fd12:3456:789a:abcd::1'), 'fd12:3456:789a:abcd');
  assert.equal(subnetOf(null), null);
  assert.equal(
    hasMatchingSubnet([{ subnet: '192.168.1' }], [{ subnet: '192.168.1' }]),
    true
  );
  assert.equal(
    hasMatchingSubnet([{ subnet: '192.168.1' }], [{ subnet: '10.0.0' }]),
    false
  );
  assert.equal(hasMatchingSubnet(null, []), false);
});

test('candidate 字符串解析 IP', () => {
  assert.equal(
    parseCandidateIp('candidate:1 1 udp 2122260223 192.168.1.23 53423 typ host'),
    '192.168.1.23'
  );
  assert.equal(parseCandidateIp(''), null);
});
