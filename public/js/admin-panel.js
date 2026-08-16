import { $, el, toast } from './util.js';
import { api } from './api.js';
import { store, clearAuth, saveAuth } from './state.js';
import { viewAdmin } from './admin.js';
import { applyTheme, parseTheme } from './theme.js';

/** 管理面板：仅管理员可登录；纯 REST（不连 WS），允许多开且不影响其他标签页 */
export async function bootAdminPanel() {
  // 应用主题：个人偏好 > 全局
  try {
    const g = await api('/api/themes/global');
    let t = parseTheme(g.theme);
    const pref = store.user?.theme;
    if (pref && pref !== 'default') t = parseTheme(pref);
    await applyTheme(t);
  } catch {
    await applyTheme(null);
  }

  const app = $('#app');
  const userArea = $('#nav-user-area');

  async function render() {
    app.innerHTML = '';
    if (store.token && store.user?.role === 'admin') {
      userArea.innerHTML = '';
      userArea.append(el('span', { class: 'muted small', text: `🛡️ ${store.user.username || store.user.nickname || ''}` }));
      const logout = el('button', { class: 'btn small', text: '退出' });
      logout.addEventListener('click', async () => {
        try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
        clearAuth();
        render();
      });
      userArea.append(logout);
      viewAdmin(app);
      return;
    }
    renderLogin(app);
  }

  function renderLogin(app) {
    userArea.innerHTML = '';
    const username = el('input', { type: 'text', placeholder: '管理员用户名' });
    const password = el('input', { type: 'password', placeholder: '密码' });
    const msg = el('div', { class: 'muted', style: 'margin-top:8px' });
    const form = el('div', { class: 'panel', style: 'max-width:360px;margin:40px auto' }, [
      el('h2', { style: 'margin-bottom:12px', text: '管理面板登录' }),
      el('div', { class: 'form-group' }, [el('label', { text: '用户名' }), username]),
      el('div', { class: 'form-group' }, [el('label', { text: '密码' }), password]),
      el('button', {
        class: 'btn',
        text: '登录',
        onClick: async () => {
          try {
            const d = await api('/api/auth/login', { method: 'POST', body: { username: username.value, password: password.value } });
            if (d.user?.role !== 'admin') {
              msg.textContent = '该账号不是管理员，无法进入管理面板';
              return;
            }
            saveAuth(d.token, d.user);
            if (d.user.mustChange) return renderChange(app);
            render();
          } catch (e) {
            msg.textContent = e.message;
          }
        },
      }),
      msg,
    ]);
    app.append(el('div', { class: 'container' }, [form]));
  }

  function renderChange(app) {
    app.innerHTML = '';
    const nu = el('input', { type: 'text', placeholder: '新用户名' });
    const np = el('input', { type: 'password', placeholder: '新密码' });
    const msg = el('div', { class: 'muted', style: 'margin-top:8px' });
    const form = el('div', { class: 'panel', style: 'max-width:360px;margin:40px auto' }, [
      el('h2', { style: 'margin-bottom:12px', text: '首次登录请修改管理员用户名和密码' }),
      el('div', { class: 'form-group' }, [el('label', { text: '新用户名' }), nu]),
      el('div', { class: 'form-group' }, [el('label', { text: '新密码' }), np]),
      el('button', {
        class: 'btn',
        text: '保存',
        onClick: async () => {
          try {
            await api('/api/auth/change-password', { method: 'POST', body: { newUsername: nu.value, newPassword: np.value } });
            store.user = { ...store.user, username: nu.value, mustChange: false };
            sessionStorage.setItem('wd_admin_user', JSON.stringify(store.user));
            toast('管理员凭据已更新');
            render();
          } catch (e) {
            msg.textContent = e.message;
          }
        },
      }),
      msg,
    ]);
    app.append(el('div', { class: 'container' }, [form]));
  }

  render();
}
