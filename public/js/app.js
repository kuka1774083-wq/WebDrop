import { $, el, toast } from './util.js';
import { api, setStore } from './api.js';
import { store, setWs, clearAuth, saveAuth } from './state.js';
import { WsClient } from './ws.js';
import { viewHome, viewLogin, viewRegister, viewRooms, viewRoom, viewSettings } from './views.js';
import { viewAdmin } from './admin.js';
import { getDeviceId, getDeviceInfo } from './device.js';
import { applyTheme, parseTheme } from './theme.js';

setStore(store);

let currentCleanup = null;
let wsc = null;

function updateNav() {
  const user = store.user;
  const adminLink = $('#nav-admin');
  const userSpan = $('#nav-user');
  const logoutBtn = $('#btn-logout');
  adminLink.classList.toggle('hidden', user?.role !== 'admin');
  const adminMode = user?.role === 'admin';
  $('#nav-p2p').classList.toggle('hidden', adminMode);
  $('#nav-rooms').classList.toggle('hidden', adminMode);
  userSpan.innerHTML = '';
  const hash = location.hash.replace(/^#/, '') || '/';
  if (user && store.token) {
    const name = user.nickname || user.username || user.uuid || '';
    const icon = user.role === 'admin' ? '🛡️' : '👤';
    const a = document.createElement('a');
    a.className = 'nav-name';
    a.href = user.role === 'admin' ? '#/admin' : '#/settings';
    a.textContent = `${icon} ${name}`;
    a.classList.toggle('active', hash === (user.role === 'admin' ? '/admin' : '/settings'));
    userSpan.append(a);
    logoutBtn.classList.remove('hidden');
  } else {
    const a = document.createElement('a');
    a.className = 'nav-name';
    a.href = '#/login';
    a.textContent = '登录 / 注册';
    a.classList.toggle('active', hash === '/login' || hash === '/register');
    userSpan.append(a);
    logoutBtn.classList.add('hidden');
  }
  for (const a of document.querySelectorAll('#nav a[data-nav]')) {
    const target = a.getAttribute('data-nav');
    a.classList.toggle('active', hash === target || (target === '/' && hash === '/'));
  }
}

function showMultiOpen() {
  if (document.getElementById('multi-open')) return;
  const overlay = el('div', { id: 'multi-open' }, [
    el('div', { class: 'multi-open-box' }, [
      el('div', { class: 'multi-open-icon', text: '🚫' }),
      el('h2', { text: '本页面不支持多开' }),
      el('p', { text: '检测到本浏览器已有其他窗口打开 WebDrop。请关闭其他窗口后刷新本页，或使用另一浏览器打开本页面继续使用。' }),
      el('button', { class: 'btn', text: '刷新本页', onClick: () => location.reload() }),
    ]),
  ]);
  document.body.append(overlay);
}

function route() {
  currentCleanup?.();
  const app = $('#app');
  app.innerHTML = '';
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);
  const user = store.user;

  if (user?.role === 'admin' && parts[0] !== 'admin') {
    location.replace('#/admin');
    return;
  }
  if (parts[0] === 'admin' && user?.role !== 'admin') {
    location.replace('#/');
    return;
  }
  if (parts[0] === 'settings' && (user?.role !== 'registered' || !store.token)) {
    location.replace('#/');
    return;
  }

  const clean = (fn) => {
    currentCleanup = fn;
  };

  if (parts[0] === 'admin') {
    clean(viewAdmin(app));
  } else if (parts[0] === 'login') {
    clean(viewLogin(app));
  } else if (parts[0] === 'register') {
    clean(viewRegister(app));
  } else if (parts[0] === 'settings') {
    clean(viewSettings(app));
  } else if (parts[0] === 'rooms') {
    clean(viewRooms(app));
  } else if (parts[0] === 'room' && parts[1]) {
    clean(viewRoom(app, decodeURIComponent(parts[1])));
  } else {
    clean(viewHome(app));
  }
  updateNav();
}

async function boot() {
  // 校验已有登录态
  if (store.token) {
    try {
      const d = await api('/api/auth/me');
      saveAuth(store.token, { ...store.user, ...d.user });
    } catch {
      clearAuth();
    }
  }
  // 应用主题：个人偏好 > 全局主题 > 默认
  try {
    const g = await api('/api/themes/global');
    let t = parseTheme(g.theme);
    const pref = store.user?.theme;
    if (pref && pref !== 'default') t = parseTheme(pref);
    await applyTheme(t);
  } catch {
    await applyTheme(null);
  }

  const [deviceId, deviceInfo] = await Promise.all([getDeviceId(), Promise.resolve(getDeviceInfo())]);
  wsc = new WsClient({ tempId: store.tempId, token: store.token, deviceId, deviceInfo });
  setWs(wsc);
  wsc.on('hello', (m) => {
    store.myDeviceKey = m.deviceKey || '';
    if (m.user) {
      store.user = store.user && store.token ? { ...store.user, ...m.user } : m.user;
      updateNav();
      // 临时用户刷新后身份异步到达：重绘当前房间，修正自己气泡的归属（否则会跑到左侧）
      const parts = (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean);
      if (parts[0] === 'room' && store.user?.role === 'temp') {
        window.dispatchEvent(new Event('wd-refresh'));
      }
    }
    // WS（重）连接成功后重新订阅当前房间：避免断线重连后收不到实时消息
    const parts2 = (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean);
    if (parts2[0] === 'room' && parts2[1]) {
      wsc.send({ type: 'roomJoin', number: decodeURIComponent(parts2[1]) });
    }
    // 重连成功后也做一次“回到前台”检查（对方在线 + 补拉消息）
    window.dispatchEvent(new Event('wd-resume'));
  });
  // 页面回到前台（如关闭系统文件选择器）：恢复心跳并同步会话状态
  wsc.onResume = () => {
    wsc.setFilePick(false);
    window.dispatchEvent(new Event('wd-resume'));
  };
  // 在线列表全局保活：切到其他页面再回来时列表不丢失
  wsc.on('onlineList', (m) => {
    store.onlineDevices = m.devices || [];
  });
  wsc.on('error', (m) => {
    if (m.error) toast(m.error, 'error');
  });
  wsc.on('kicked', () => {
    clearAuth();
    location.reload();
  });
  wsc.on('multiOpen', () => {
    wsc.stop();
    showMultiOpen();
  });
  wsc.on('roomKicked', (m) => {
    toast(m.reason === 'blacklist' ? '你已被房主拉黑，无法再进入该房间' : '你已被房主移出房间', 'error', 4000);
    wsc.send({ type: 'roomLeave', number: m.number });
    const parts = (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean);
    if (parts[0] === 'room' && decodeURIComponent(parts[1]) === m.number) {
      location.hash = '#/rooms';
      window.dispatchEvent(new Event('wd-refresh'));
    }
  });
  wsc.on('incomingRequest', (m) => {
    if (!store.requests.some((r) => r.sessionId === m.sessionId)) {
      store.requests.push(m);
      toast(`收到来自 ${m.from.name} 的会话请求`, 'info', 4000);
    }
  });
  wsc.on('sessionEnded', (m) => {
    store.requests = store.requests.filter((x) => x.sessionId !== m.sessionId);
  });
  wsc.on('deviceKicked', (m) => {
    clearAuth();
    toast(m.reason || '设备已被下线', 'error', 4000);
    location.hash = '#/login';
    location.reload();
  });
  wsc.connect();

  window.addEventListener('hashchange', route);
  window.addEventListener('wd-refresh', route);
  route();

  $('#btn-logout').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch { /* ignore */ }
    clearAuth();
    location.hash = '#/';
    location.reload();
  });

  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.addEventListener('click', () => {
      location.hash = a.getAttribute('data-nav');
    });
  });
}

boot();
