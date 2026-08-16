// 管理面板入口：独立 URL /admin，使用会话级存储（登录态不落盘），可多开
import { configureStore, store } from './state.js';
import { setStore } from './api.js';

configureStore({
  storage: sessionStorage,
  tempKey: 'wd_admin_temp',
  tokenKey: 'wd_admin_token',
  userKey: 'wd_admin_user',
});
setStore(store);

const { bootAdminPanel } = await import('./admin-panel.js');
bootAdminPanel();
