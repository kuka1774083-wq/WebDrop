// 设备指纹：确定性计算，同一设备/浏览器重新计算结果一致
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

async function sha256Hex(str) {
  try {
    if (globalThis.crypto?.subtle?.digest) {
      const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* 回退 */ }
  // 回退：多轮 FNV 拼接为 32 位十六进制
  let out = '';
  for (let seed = 0; seed < 4; seed++) out += fnv1a(`${seed}|${str}`);
  return out;
}

function collectSignals() {
  const signals = [
    navigator.userAgent,
    navigator.language,
    (navigator.languages || []).join(','),
    navigator.platform || '',
    String(screen.width || ''),
    String(screen.height || ''),
    String(screen.colorDepth || ''),
    Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    String(navigator.hardwareConcurrency || ''),
    String(navigator.deviceMemory || ''),
    String(navigator.maxTouchPoints || 0),
  ];
  try {
    const c = document.createElement('canvas');
    c.width = 240;
    c.height = 60;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(10, 10, 120, 30);
    ctx.fillStyle = '#069';
    ctx.font = '16px Georgia';
    ctx.fillText('WebDrop 设备指纹', 20, 20);
    signals.push(c.toDataURL());
  } catch { /* ignore */ }
  return signals.join('|');
}

/** 客户端设备 UUID：唯一且可重复计算；缓存丢失后重算结果一致 */
export async function getDeviceId() {
  const cached = localStorage.getItem('wd_device_id');
  if (cached) return cached;
  const hash = await sha256Hex(collectSignals());
  const id = hash.slice(0, 32).toUpperCase();
  localStorage.setItem('wd_device_id', id);
  return id;
}

/** 设备信息（浏览器/机型），用于设置页展示 */
export function getDeviceInfo() {
  const ua = navigator.userAgent || '';
  let browser = '浏览器';
  let model = navigator.platform || '未知设备';
  try {
    const uaData = navigator.userAgentData;
    if (uaData) {
      const brand = (uaData.brands || []).find((b) => b.brand && !b.brand.startsWith('Not'))?.brand || '';
      if (brand) browser = `${brand}${uaData.mobile ? '（移动端）' : '（桌面端）'}`;
      if (uaData.platform) model = uaData.platform;
    }
  } catch { /* ignore */ }
  if (/iPhone/.test(ua)) model = 'iPhone';
  else if (/Android/.test(ua)) model = 'Android 设备';
  else if (/Windows/.test(ua)) model = 'Windows 电脑';
  else if (/Mac OS X/.test(ua)) model = 'Mac';
  else if (/Linux/.test(ua)) model = 'Linux 设备';
  return { browser, model };
}
