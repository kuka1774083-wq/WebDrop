import { genTempId } from './util.js';

let storageImpl = localStorage;
let keys = { temp: 'wd_temp', token: 'wd_token', user: 'wd_user' };

export const store = {
  tempId: '',
  token: '',
  user: null,
  onlineDevices: [],
  myDeviceKey: '',
  requests: [],
  sessions: new Map(),
  activeSessionId: null,
  currentRoom: null,
};

/** 切换存储后端与键名（管理面板使用 sessionStorage + wd_admin_*，登录态不落盘） */
export function configureStore({ storage, tempKey, tokenKey, userKey } = {}) {
  storageImpl = storage || localStorage;
  keys = {
    temp: tempKey || 'wd_temp',
    token: tokenKey || 'wd_token',
    user: userKey || 'wd_user',
  };
  store.tempId = storageImpl.getItem(keys.temp) || (storageImpl.setItem(keys.temp, genTempId()), storageImpl.getItem(keys.temp));
  store.token = storageImpl.getItem(keys.token) || '';
  try { store.user = JSON.parse(storageImpl.getItem(keys.user) || 'null'); } catch { store.user = null; }
}
configureStore();

export let ws = null;
export function setWs(w) {
  ws = w;
}

export function saveAuth(token, user) {
  store.token = token;
  store.user = user;
  // 管理员登录状态不记录到 localStorage：改用会话级存储，标签页关闭即失效
  if (user?.role === 'admin') {
    sessionStorage.setItem('wd_admin_token', token);
    sessionStorage.setItem('wd_admin_user', JSON.stringify(user));
  } else {
    storageImpl.setItem(keys.token, token);
    storageImpl.setItem(keys.user, JSON.stringify(user));
  }
}

export function clearAuth() {
  store.token = '';
  store.user = null;
  storageImpl.removeItem(keys.token);
  storageImpl.removeItem(keys.user);
  sessionStorage.removeItem('wd_admin_token');
  sessionStorage.removeItem('wd_admin_user');
}

export function myUserId() {
  return store.user?.id;
}
