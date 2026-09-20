export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

export function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 2)} ${units[i]}`;
}

export function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function toast(msg, type = 'info', ms = 3500) {
  const box = $('#toast-wrap');
  const t = el('div', { class: `toast ${type === 'error' ? 'error' : ''}`, text: msg });
  // 点击可提前关闭
  const timer = setTimeout(() => t.remove(), ms);
  t.addEventListener('click', () => {
    clearTimeout(timer);
    t.remove();
  });
  box.append(t);
}

export function genTempId() {
  const len = 10 + Math.floor(Math.random() * 7);
  const chars = 'ABCDEF0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// 每个弹窗占用一条同 URL 的历史记录，移动端返回键可优先关闭最上层弹窗。
const modalStack = [];
let nextModalId = 0;
let ignoredModalPops = 0;

function cleanupModalRoot(root) {
  if (root.querySelector('.modal')) return;
  root.classList.remove('open');
  // 弹窗全部关闭后，把挂在弹窗层内的播放器移回 body，避免随弹窗层一起隐藏
  const players = root.querySelectorAll('.voice-player');
  for (const p of players) {
    p.style.zIndex = '';
    document.body.append(p);
  }
}

function closeModal(record, { fromHistory = false } = {}) {
  if (record.closed) return;
  record.closed = true;
  const index = modalStack.indexOf(record);
  if (index !== -1) modalStack.splice(index, 1);
  record.layer.remove();
  cleanupModalRoot(record.root);
  if (record.historyPushed && !fromHistory) {
    ignoredModalPops += 1;
    history.back();
  }
}

function handleModalBack(record) {
  if (record.onBack?.() !== true) return false;
  if (record.historyPushed) {
    history.pushState({ ...(history.state || {}), webdropModal: record.id }, '', location.href);
  }
  return true;
}

window.addEventListener('popstate', () => {
  if (ignoredModalPops > 0) {
    ignoredModalPops -= 1;
    return;
  }
  const top = modalStack.at(-1);
  if (top && !handleModalBack(top)) closeModal(top, { fromHistory: true });
});

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const top = modalStack.at(-1);
  if (!top) return;
  event.preventDefault();
  closeModal(top);
});

export function modal({ title, body, actions = [], className = '', onBack }) {
  const root = $('#modal-root');
  const backdrop = el('div', { class: 'modal-backdrop' });
  const box = el('div', { class: `modal ${className}`.trim() }, [
    el('h3', { text: title }),
    ...(body.nodeType ? [body] : [el('div', {}, [body])]),
    el('div', { class: 'actions' }, actions.map((a) => el('button', { class: `btn ${a.class || ''}`, text: a.label, onClick: a.onClick }))),
  ]);
  const layer = el('div', { class: 'modal-layer' }, [backdrop, box]);
  root.append(layer);
  root.classList.add('open');
  const record = {
    id: ++nextModalId,
    root,
    layer,
    onBack,
    closed: false,
    historyPushed: false,
  };
  modalStack.push(record);
  try {
    history.pushState({ ...(history.state || {}), webdropModal: record.id }, '', location.href);
    record.historyPushed = true;
  } catch {
    // 受限 WebView 中仍保留弹窗本身，只是无法接管系统返回键。
  }
  const close = () => closeModal(record);
  return { close, box };
}

export function confirmDialog(title, message, okLabel = '确定', danger = false) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      body: message,
      actions: [
        { label: '取消', class: 'secondary', onClick: () => { resolve(false); m.close(); } },
        { label: okLabel, class: danger ? 'danger' : 'ok', onClick: () => { resolve(true); m.close(); } },
      ],
    });
  });
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}
