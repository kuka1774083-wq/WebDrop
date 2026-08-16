import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { Router, sendJson, nowIso } from './http.js';
import { getSetting, setSetting } from './db.js';

// 主题名支持中文/字母/数字/_-（Unicode 字母与数字），禁止 / \ . : 空格等路径与解析分隔符
const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

const DEFAULT_META = {
  name: 'default',
  version: '1.0.0',
  author: 'WebDrop',
  description: '默认浅色新拟物主题（内置，不可删除）',
};

const DEFAULT_THEME_CSS = `/* ============================================================
 * WebDrop 主题包模板（默认浅色新拟物主题）
 * ------------------------------------------------------------
 * 使用方式：
 *   1. 修改下方 :root 中的 CSS 变量即可整体换肤；
 *   2. 如需微调组件，可在变量之后追加任意 CSS 规则；
 *   3. 打包时请同时包含本文件与 theme.json（见模板说明）。
 *
 * 变量说明：
 *   --bg               页面主背景色（新拟物通常为浅灰，如 #e0e5ec）
 *   --panel-bg         卡片/面板/弹窗背景，默认同 --bg，主题可单独覆盖
 *   --bg-soft          次级背景（表格表头、次要卡片等）
 *   --bg-deep          更深的凹陷色（进度条轨道等）
 *   --dark             双重阴影中的深色阴影（右下）
 *   --light            双重阴影中的亮色阴影（左上，通常为白色系）
 *   --text             正文文字颜色
 *   --text-strong      标题/强调文字颜色
 *   --text-muted       弱化文字颜色（提示、时间等）
 *   --accent           主强调色（主按钮、聊天气泡、链接）
 *   --ok               成功/在线等状态色
 *   --warn             警告/繁忙等状态色
 *   --danger           危险/删除等状态色
 *   --on-accent        accent 背景上的文字颜色（避免写死纯白）
 *   --on-ok            ok 背景上的文字颜色
 *   --on-danger        danger 背景上的文字颜色
 *   --btn-secondary-bg 次要按钮背景
 *   --btn-secondary-text 次要按钮文字
 *   --border           表格等分隔线颜色
 *   --overlay          弹窗遮罩颜色
 *   --header-shadow    页头底部阴影颜色
 *   --head-shadow      聊天头部阴影颜色
 *   --input-shadow     聊天输入区顶部阴影颜色
 *   --glow-ring        会话请求闪烁光环颜色
 *   --msg-time-own     自己气泡内时间文字颜色
 *   --dot-inset        在线状态点内阴影
 *   --badge-*-bg/text  各状态徽章背景与文字（ok/warn/danger/muted）
 *   --radius           小圆角（按钮、输入框）
 *   --radius-lg        大圆角（卡片、面板、弹窗）
 *   --shadow-sm/md/lg  凸起阴影（默认由 --dark/--light 双色合成；
 *                      非新拟物主题可直接覆盖为硬边投影，如 5px 5px 0 0 #111）
 *   --shadow-inset-sm/md 内凹阴影（输入框、选中/按下态，可整体覆盖）
 *
 * 进阶：变量之外允许追加任意组件规则。要做非新拟物主题（如孟菲斯的
 * 粗黑描边 + 硬阴影 + 几何图案），直接在 :root 之后覆盖组件即可，例如：
 *   .btn, .panel, .card, input { border: 3px solid #111; border-radius: 0; }
 *   body { background-image: radial-gradient(...); }
 * ============================================================ */
:root {
  --bg: #e0e5ec;
  --panel-bg: var(--bg);
  --bg-soft: #f0f0f3;
  --bg-deep: #d4d9e1;
  --dark: #b8bcc2;
  --light: #ffffff;
  --text: #4b5563;
  --text-strong: #1f2937;
  --text-muted: #9ca3af;
  --accent: #6d5dfc;
  --ok: #4ecdc4;
  --warn: #ffe66d;
  --danger: #ff6b6b;
  --on-accent: #ffffff;
  --on-ok: #06302c;
  --on-danger: #ffffff;
  --btn-secondary-bg: var(--bg-soft);
  --btn-secondary-text: var(--text-strong);
  --border: rgba(31, 41, 55, .07);
  --overlay: rgba(31, 41, 55, .4);
  --header-shadow: rgba(184, 188, 194, .55);
  --head-shadow: rgba(184, 188, 194, .35);
  --input-shadow: rgba(184, 188, 194, .3);
  --glow-ring: rgba(109, 93, 252, 0);
  --msg-time-own: rgba(255, 255, 255, .7);
  --dot-inset: rgba(0, 0, 0, .2);
  --badge-ok-bg: rgba(78, 205, 196, .25);
  --badge-ok-text: #0b7d75;
  --badge-warn-bg: rgba(255, 230, 109, .4);
  --badge-warn-text: #7a5c00;
  --badge-danger-bg: rgba(255, 107, 107, .25);
  --badge-danger-text: #b02a2a;
  --badge-muted-bg: var(--bg-soft);
  --badge-muted-text: var(--text-muted);
  --radius: 14px;
  --radius-lg: 20px;
}
/* 示例：如需微调组件，取消注释并按需修改
.chat-wrap { border-radius: 24px; }
.btn { font-weight: 600; }
*/
`;

function safeName(name) {
  return NAME_RE.test(name) ? name : null;
}

function readThemeMeta(dir, fallback) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'theme.json'), 'utf8');
    const meta = JSON.parse(raw);
    return {
      name: String(meta.name || fallback.name || ''),
      version: String(meta.version || '1.0.0'),
      author: String(meta.author || '未知'),
      description: String(meta.description || ''),
    };
  } catch {
    return {
      name: fallback.name || '',
      version: '1.0.0',
      author: '未知',
      description: '',
    };
  }
}

function readDirNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function collectBody(req, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const e = new Error('文件过大');
      e.statusCode = 413;
      throw e;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function extractTheme(buf) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new Error('无效的 zip 主题包');
  }
  const themeJson = zip.file('theme.json');
  const themeCss = zip.file('theme.css');
  if (!themeJson || !themeCss) {
    throw new Error('主题包需包含 theme.json 与 theme.css');
  }
  let meta;
  try {
    meta = JSON.parse(await themeJson.async('string'));
  } catch {
    throw new Error('theme.json 解析失败');
  }
  const name = safeName(String(meta.name || ''));
  if (!name) throw new Error('主题名需为 1-32 位中文/字母/数字/_-');
  const css = await themeCss.async('string');
  if (!css.includes(':root')) throw new Error('theme.css 需包含 :root 变量定义');
  return {
    name,
    meta: {
      name,
      version: String(meta.version || '1.0.0'),
      author: String(meta.author || '未知'),
      description: String(meta.description || ''),
      createdAt: nowIso(),
    },
    css,
  };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function themeRoutes({ db, cfg, service, hub }) {
  const r = new Router();
  const themesRoot = path.join(cfg.dataDir, 'themes');
  const publicDir = path.join(themesRoot, 'public');
  const userDir = (uuid) => path.join(themesRoot, String(uuid));
  ensureDir(publicDir);

  const requireUser = (req, res) => {
    const user = service.identify(req);
    if (!user) {
      sendJson(res, 401, { error: '身份无效' });
      return null;
    }
    return user;
  };

  const requireAdmin = (req, res) => {
    const user = requireUser(req, res);
    if (!user) return null;
    if (user.role !== 'admin') {
      sendJson(res, 403, { error: '需要管理员权限' });
      return null;
    }
    return user;
  };

  function publicThemes() {
    return readDirNames(publicDir).map((name) => ({
      ...readThemeMeta(path.join(publicDir, name), { name }),
      source: 'public',
      deletable: false,
    }));
  }

  r.get('/api/themes', (req, res) => {
    // 默认与公共主题无需登录即可浏览；个人主题仅本人可见
    const user = service.identify(req);
    const out = [
      { ...DEFAULT_META, source: 'default', deletable: false },
      ...publicThemes(),
    ];
    if (user && user.role === 'registered' && user.uuid) {
      for (const name of readDirNames(userDir(user.uuid))) {
        out.push({
          ...readThemeMeta(path.join(userDir(user.uuid), name), { name }),
          source: 'user',
          deletable: true,
        });
      }
    }
    sendJson(res, 200, { themes: out });
  });

  r.get('/api/themes/css', (req, res) => {
    const user = service.identify(req);
    const source = String(req.query.get('source') || 'default');
    const name = safeName(String(req.query.get('name') || ''));
    if (!name) return sendJson(res, 400, { error: '主题名无效' });
    if (source === 'default') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      return res.end(DEFAULT_THEME_CSS);
    }
    if (source === 'public') {
      const p = path.join(publicDir, name, 'theme.css');
      if (!fs.existsSync(p)) return sendJson(res, 404, { error: '主题不存在' });
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      return fs.createReadStream(p).pipe(res);
    }
    if (source === 'user') {
      if (!user || user.role !== 'registered' || !user.uuid) {
        return sendJson(res, 401, { error: '仅本人可访问个人主题' });
      }
      const p = path.join(userDir(user.uuid), name, 'theme.css');
      if (!fs.existsSync(p)) return sendJson(res, 404, { error: '主题不存在' });
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      return fs.createReadStream(p).pipe(res);
    }
    sendJson(res, user ? 403 : 401, { error: '无权访问该主题' });
  });

  r.post('/api/themes/upload', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (user.role !== 'registered' || !user.uuid) {
      return sendJson(res, 403, { error: '仅注册用户可上传个人主题' });
    }
    const buf = await collectBody(req);
    let theme;
    try {
      theme = await extractTheme(buf);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const dir = path.join(userDir(user.uuid), theme.name);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(theme.meta, null, 2));
    fs.writeFileSync(path.join(dir, 'theme.css'), theme.css);
    sendJson(res, 201, { ok: true, theme: { ...theme.meta, source: 'user', deletable: true } });
  });

  r.delete('/api/themes/:name', (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const name = safeName(req.params.name);
    if (!name) return sendJson(res, 400, { error: '主题名无效' });
    if (user.role !== 'registered' || !user.uuid) {
      return sendJson(res, 403, { error: '仅可删除自己的主题' });
    }
    const dir = path.join(userDir(user.uuid), name);
    if (!fs.existsSync(dir)) return sendJson(res, 404, { error: '主题不存在' });
    fs.rmSync(dir, { recursive: true, force: true });
    sendJson(res, 200, { ok: true });
  });

  r.post('/api/auth/theme', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (user.role !== 'registered') {
      return sendJson(res, 403, { error: '仅注册用户可保存主题偏好' });
    }
    const b = await (await import('./http.js')).readJson(req);
    const theme = String(b.theme || 'default').slice(0, 64);
    db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, user.id);
    sendJson(res, 200, { ok: true, theme });
  });

  r.get('/api/themes/global', (req, res) => {
    sendJson(res, 200, { theme: getSetting(db, 'globalTheme', 'default') });
  });

  // 普通用户也可下载示例主题模板
  r.get('/api/themes/template', async (req, res) => {
    const zip = new JSZip();
    zip.file('theme.json', JSON.stringify({ ...DEFAULT_META, description: 'WebDrop 默认主题模板，修改 theme.css 中的变量即可换肤' }, null, 2));
    zip.file('theme.css', DEFAULT_THEME_CSS);
    zip.file('README.txt', 'WebDrop 主题包模板\n\n将本 zip 直接上传到 WebDrop 即可使用。\n1) theme.json：主题元信息（name 必须唯一且为 1-32 位中文/字母/数字/_-）；\n2) theme.css：覆盖 :root CSS 变量，详见文件内注释。\n\n管理端：上传到 data/themes/public 供全局使用；\n普通用户：上传为个人主题（保存在 data/themes/{用户UUID}，注销时删除）。\n');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="webdrop-theme-template.zip"',
      'Content-Length': buf.length,
    });
    res.end(buf);
  });

  // ---- 管理端 ----
  r.get('/api/admin/themes', (req, res) => {
    const user = requireAdmin(req, res);
    if (!user) return;
    sendJson(res, 200, {
      themes: [
        { ...DEFAULT_META, source: 'default', deletable: false },
        ...publicThemes().map((t) => ({ ...t, deletable: true })),
      ],
      globalTheme: getSetting(db, 'globalTheme', 'default'),
    });
  });

  r.post('/api/admin/themes/upload', async (req, res) => {
    const user = requireAdmin(req, res);
    if (!user) return;
    const buf = await collectBody(req);
    let theme;
    try {
      theme = await extractTheme(buf);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const dir = path.join(publicDir, theme.name);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(theme.meta, null, 2));
    fs.writeFileSync(path.join(dir, 'theme.css'), theme.css);
    sendJson(res, 201, { ok: true, theme: { ...theme.meta, source: 'public', deletable: true } });
  });

  r.delete('/api/admin/themes/:name', (req, res) => {
    const user = requireAdmin(req, res);
    if (!user) return;
    const name = safeName(req.params.name);
    if (!name) return sendJson(res, 400, { error: '主题名无效' });
    if (name === 'default') return sendJson(res, 403, { error: '默认主题不可删除' });
    const dir = path.join(publicDir, name);
    if (!fs.existsSync(dir)) return sendJson(res, 404, { error: '主题不存在' });
    fs.rmSync(dir, { recursive: true, force: true });
    sendJson(res, 200, { ok: true });
  });

  r.post('/api/admin/themes/global', async (req, res) => {
    const user = requireAdmin(req, res);
    if (!user) return;
    const b = await (await import('./http.js')).readJson(req);
    const theme = String(b.theme || 'default').slice(0, 64);
    setSetting(db, 'globalTheme', theme);
    sendJson(res, 200, { ok: true, theme });
  });

  r.get('/api/admin/themes/template', async (req, res) => {
    const user = requireAdmin(req, res);
    if (!user) return;
    const zip = new JSZip();
    zip.file('theme.json', JSON.stringify({ ...DEFAULT_META, description: 'WebDrop 默认主题模板，修改 theme.css 中的变量即可换肤' }, null, 2));
    zip.file('theme.css', DEFAULT_THEME_CSS);
    zip.file('README.txt', 'WebDrop 主题包模板\n\n将本 zip 直接上传到 WebDrop 即可使用。\n1) theme.json：主题元信息（name 必须唯一且为 1-32 位中文/字母/数字/_-）；\n2) theme.css：覆盖 :root CSS 变量，详见文件内注释。\n\n管理端：上传到 data/themes/public 供全局使用；\n普通用户：上传为个人主题（保存在 data/themes/{用户UUID}，注销时删除）。\n');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="webdrop-theme-template.zip"',
      'Content-Length': buf.length,
    });
    res.end(buf);
  });

  return r;
}

export function removeUserThemes(dataDir, uuid) {
  if (!uuid) return;
  fs.rmSync(path.join(dataDir, 'themes', String(uuid)), { recursive: true, force: true });
}
