import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

export function randomId(len = 16) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

/** 临时用户 UUID：变长 10-16 位 */
export function genTempUuid() {
  const len = 10 + crypto.randomInt(7);
  return randomId(len).toUpperCase();
}

const NICK_ADJ = [
  '可爱的', '愤怒的', '快乐的', '神秘的', '机智的', '温柔的', '勇敢的', '害羞的',
  '帅气的', '呆萌的', '机灵的', '大方的', '好奇的', '贪吃的', '安静的', '活泼的',
  '糊涂的', '认真的', '幸运的', '调皮的', '傲娇的', '慵懒的', '酷酷的', '软萌的',
];
const NICK_NOUN = [
  '桃子', '香蕉', '苹果', '草莓', '西瓜', '菠萝', '橙子', '葡萄', '芒果', '柠檬',
  '樱桃', '猕猴桃', '蓝莓', '火龙果', '椰子', '荔枝', '柚子', '蜜瓜',
  '兔子', '猫咪', '小狗', '熊猫', '老虎', '狐狸', '仓鼠', '刺猬', '企鹅', '鲸鱼', '海豚',
];

/** 临时用户自动分配好记好看的昵称（形容词 + 水果/动物） */
export function genTempNickname(existing = new Set()) {
  for (let i = 0; i < 40; i++) {
    const adj = NICK_ADJ[Math.floor(Math.random() * NICK_ADJ.length)];
    const noun = NICK_NOUN[Math.floor(Math.random() * NICK_NOUN.length)];
    const name = adj + noun;
    if (!existing.has(name)) return name;
  }
  return `访客${Math.floor(Math.random() * 10000)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function addMinutes(ms) {
  return new Date(Date.now() + ms).toISOString();
}

export function parseIsoOrNull(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scryptAsync(pw, salt, 64);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(pw, stored) {
  try {
    const [scheme, salt, hex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !hex) return false;
    const hash = await scryptAsync(pw, salt, 64);
    const a = Buffer.from(hex, 'hex');
    const b = Buffer.from(hash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 2)} ${units[i]}`;
}

export const ROOM_QUOTA_BY_LEVEL = [1, 2, 3, 4, 6, 8, 10];

export function roomQuotaForLevel(level) {
  const l = Math.max(0, Math.min(6, Number(level) || 0));
  return ROOM_QUOTA_BY_LEVEL[l];
}

/** 持久存储 = baseGb + 等级 × 50G */
export function quotaBytesForLevel(baseGb, level) {
  const l = Math.max(0, Math.min(6, Number(level) || 0));
  return (Number(baseGb) + l * 50) * 1024 ** 3;
}

/** 自定义房间号：6-12 位数字/中文/大小写英文 */
export function isValidCustomRoomNumber(n) {
  return typeof n === 'string' && /^[0-9A-Za-z\u4e00-\u9fa5]{6,12}$/.test(n);
}

export function genRandomRoomNumber(existing) {
  for (let i = 0; i < 100; i++) {
    const n = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!existing.has(n)) return n;
  }
  return `${Date.now() % 1000000}`.padStart(6, '0');
}

/** 显示名：昵称优先；重名时追加 UUID 后 4 位 */
export function displayNameFor(user, peers = []) {
  let name = user.nickname || user.username || user.uuid || '访客';
  const collision = peers.some(
    (p) => p && p.id !== user.id && (p.nickname || p.username || p.uuid) === name
  );
  if (collision && user.uuid) name += `#${user.uuid.slice(-4)}`;
  return name;
}

export const DELETE_REASONS = {
  user_manual: '用户手动删除',
  auto_expired: '文件自动过期',
  session_destroyed: '会话销毁',
  room_destroyed: '房间销毁',
  admin_deleted: '管理员删除',
  user_deleted: '用户已删除',
  folder_deleted: '文件夹删除',
};

export function deleteReasonLabel(reason) {
  return DELETE_REASONS[reason] || reason || '-';
}

export function kindForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'voice';
  return 'file';
}

export function safeFilename(name) {
  const s = String(name || 'file').replace(/[\\/]/g, '_').slice(0, 255);
  return s || 'file';
}

export function expiresChoiceToIso(choice) {
  if (!choice || choice === 'permanent') return null;
  const map = { h1: 3600e3, d1: 86400e3, d7: 7 * 86400e3, d30: 30 * 86400e3 };
  if (map[choice]) return new Date(Date.now() + map[choice]).toISOString();
  const t = Date.parse(choice);
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  return null;
}
