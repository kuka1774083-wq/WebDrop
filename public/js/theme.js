import { api, authHeaders } from './api.js';
import { el, modal, toast } from './util.js';

let currentTheme = { source: 'default', name: 'default' };

export function getCurrentTheme() {
  return currentTheme;
}

export function parseTheme(s) {
  const parts = String(s || 'default').split(':');
  if (parts.length === 1) return { source: 'default', name: parts[0] || 'default' };
  return { source: parts[0], name: parts[1] || 'default' };
}

export async function fetchThemeCss(theme) {
  if (!theme || theme.source === 'default') return null;
  const res = await fetch(`/api/themes/css?source=${theme.source}&name=${encodeURIComponent(theme.name)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const t = await res.text();
    let msg = '主题加载失败';
    try { msg = JSON.parse(t).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.text();
}

export function applyCss(css) {
  let st = document.getElementById('wd-theme');
  if (!st) {
    st = document.createElement('style');
    st.id = 'wd-theme';
    document.head.append(st);
  }
  st.textContent = css || '';
}

export async function applyTheme(theme) {
  currentTheme = theme || { source: 'default', name: 'default' };
  const css = await fetchThemeCss(currentTheme);
  applyCss(css);
  return currentTheme;
}

export async function listThemes() {
  return api('/api/themes');
}

export async function uploadTheme(file) {
  const res = await fetch('/api/themes/upload', {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'x-file-name': encodeURIComponent(file.name),
    },
    body: file,
  });
  const text = await res.text();
  let d;
  try { d = JSON.parse(text); } catch { d = { error: '上传失败' }; }
  if (!res.ok) throw new Error(d.error || '上传失败');
  return d;
}

export async function deleteTheme(name) {
  return api(`/api/themes/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/* ---------------- 主题预览：渲染各界面效果图 ---------------- */
export function openThemePreview(theme, meta, opts = {}) {
  const previous = getCurrentTheme();
  applyTheme(theme).catch((e) => toast(e.message, 'error'));
  const body = el('div', {}, [
    el('div', { class: 'muted', style: 'margin-bottom:10px' }, [
      `版本 ${meta.version || '-'} · 作者 ${meta.author || '-'} · ${meta.description || ''}`,
    ]),
    el('div', { class: 'theme-preview-grid' }, [
      buildMockHome(),
      buildMockChat(),
      buildMockRoom(),
      buildMockSettings(),
    ]),
  ]);
  const actions = [
    ...(opts.actions || []),
    {
      label: '关闭',
      class: 'secondary',
      onClick: () => {
        m.close();
        applyTheme(previous).catch(() => {});
      },
    },
  ];
  const m = modal({
    title: `主题预览：${meta.name}`,
    body,
    actions,
    className: 'theme-preview',
  });
  return m;
}

function mockCard(title, children) {
  return el('div', { class: 'panel', style: 'padding:10px' }, [
    el('div', { style: 'font-weight:600;margin-bottom:8px;color:var(--text-strong)', text: title }),
    ...children,
  ]);
}

function buildMockHome() {
  return mockCard('点对点首页', [
    el('div', { class: 'my-banner', style: 'margin-bottom:8px' }, [el('span', { class: 'muted', text: '我的昵称：' }), el('span', { class: 'my-name', text: '示例用户' })]),
    el('div', { class: 'user-item', style: 'margin-bottom:6px' }, [el('span', { class: 'dot' }), el('span', { class: 'name', text: '在线用户 A' })]),
    el('div', { class: 'user-item' }, [el('span', { class: 'dot' }), el('span', { class: 'name', text: '在线用户 B' })]),
  ]);
}

function buildMockChat() {
  return mockCard('聊天界面', [
    el('div', { class: 'msg theirs', style: 'margin-bottom:6px' }, [el('div', { text: '你好，这是新主题' })]),
    el('div', { class: 'msg mine', style: 'margin-bottom:6px' }, [el('div', { text: '收到！' })]),
    el('div', { class: 'file-chip', style: 'margin-bottom:6px' }, [el('span', { text: '📄' }), el('span', { class: 'fname', text: '示例文件.txt' })]),
    el('div', { class: 'progress' }, [el('div', { style: 'width:60%' })]),
  ]);
}

function buildMockRoom() {
  return mockCard('房间界面', [
    el('div', { class: 'row', style: 'margin-bottom:8px' }, [
      el('span', { style: 'font-weight:600;color:var(--text-strong)', text: '房间' }),
      el('button', { class: 'btn ok small', text: '创建房间' }),
    ]),
    el('div', { class: 'file-card', style: 'max-width:160px' }, [
      el('div', { class: 'preview' }, [el('span', { text: '📄' })]),
      el('div', { class: 'info' }, [el('div', { class: 'fn', text: '示例文件' })]),
    ]),
  ]);
}

function buildMockSettings() {
  return mockCard('设置界面', [
    el('div', { class: 'row', style: 'margin-bottom:8px' }, [
      el('span', { style: 'font-weight:600;color:var(--text-strong)', text: '主题' }),
      el('span', { class: 'muted', text: '示例主题 · 当前使用' }),
    ]),
    el('div', { class: 'row', style: 'gap:12px;margin-bottom:8px' }, [
      el('label', { class: 'small' }, [el('input', { type: 'checkbox' }), ' 未选中']),
      el('label', { class: 'small' }, [el('input', { type: 'checkbox', checked: true }), ' 已选中']),
    ]),
    el('div', { class: 'theme-card', style: 'margin-bottom:8px' }, [
      el('div', { style: 'font-weight:600;color:var(--text-strong)', text: '我的设备' }),
      el('div', { class: 'muted', text: 'Chrome · Windows · 最后上线：刚刚' }),
    ]),
    el('table', {}, [
      el('thead', {}, [el('tr', {}, [el('th', { text: '设备' }), el('th', { text: '状态' })])]),
      el('tbody', {}, [el('tr', {}, [el('td', { text: '示例设备' }), el('td', {}, [el('span', { class: 'badge ok', text: '当前设备' })])])]),
    ]),
  ]);
}
