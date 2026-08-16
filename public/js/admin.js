import { el, $, toast, fmtBytes, fmtTime, confirmDialog, modal } from './util.js';
import { api, authHeaders } from './api.js';
import { openThemePreview, parseTheme } from './theme.js';

export function viewAdmin(container) {
  container.innerHTML = '';
  const root = el('div', { class: 'container admin-layout' });
  const tabs = el('div', { class: 'tabs' });
  const content = el('div');
  root.append(tabs, content);
  container.append(root);

  const defs = [
    ['dashboard', '仪表盘'],
    ['files', '文件管理'],
    ['rooms', '房间管理'],
    ['themes', '主题管理'],
    ['users', '用户管理'],
    ['approvals', '审批中心'],
    ['settings', '设置'],
  ];
  let current = 'dashboard';
  let dashTimer = null;

  function renderTabs() {
    tabs.innerHTML = '';
    for (const [id, label] of defs) {
      const t = el('div', { class: `tab ${id === current ? 'active' : ''}`, text: label });
      t.addEventListener('click', () => switchTab(id));
      tabs.append(t);
    }
  }

  function switchTab(id) {
    if (dashTimer) {
      clearInterval(dashTimer);
      dashTimer = null;
    }
    current = id;
    renderTabs();
    content.innerHTML = '';
    if (id === 'dashboard') return dashboard(content);
    if (id === 'files') return filesView(content);
    if (id === 'rooms') return roomsView(content);
    if (id === 'themes') return themesView(content);
    if (id === 'users') return usersView(content);
    if (id === 'approvals') return approvalsView(content);
    if (id === 'settings') return settingsView(content);
  }

  renderTabs();
  switchTab('dashboard');

  async function dashboard(box) {
    const grid = el('div', { class: 'stat-grid' });
    box.append(el('div', { class: 'row', style: 'margin-bottom:12px' }, [el('h3', { class: 'grow', text: '服务器状态（每 1 秒自动刷新）' })]));
    box.append(grid);
    const load = async () => {
      try {
        const d = await api('/api/admin/monitor');
        grid.innerHTML = '';
        const memPct = Math.round((d.memory.used / d.memory.total) * 100);
        const disk = d.disk.total
          ? `${fmtBytes(d.disk.used)} / ${fmtBytes(d.disk.total)}（${Math.round((d.disk.used / d.disk.total) * 100)}%）`
          : '不可用（Linux 容器内可用）';
        const stats = [
          ['CPU 使用率', `${d.cpu.toFixed(1)}%`],
          ['内存', `${fmtBytes(d.memory.used)} / ${fmtBytes(d.memory.total)}（${memPct}%）`],
          ['存储路径', d.storagePath],
          ['路径占用', disk],
          ['本项目占用', `${d.project.sizeText}（${d.project.count} 个文件）`],
        ];
        for (const [k, v] of stats) {
          grid.append(el('div', { class: 'stat' }, [el('div', { class: 'muted', text: k }), el('div', { class: 'v', style: 'font-size:14px;word-break:break-all', text: v })]));
        }
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    await load();
    if (dashTimer) clearInterval(dashTimer);
    dashTimer = setInterval(load, 1000);
  }

  async function filesView(box) {
    const scopeSel = el('select', {}, [
      el('option', { value: 'all', text: '全部范围' }),
      el('option', { value: 'room', text: '房间文件' }),
      el('option', { value: 'p2p', text: 'P2P 暂存' }),
    ]);
    const statusSel = el('select', {}, [
      el('option', { value: 'active', text: '未删除', selected: true }),
      el('option', { value: 'deleted', text: '已删除' }),
      el('option', { value: 'all', text: '全部状态' }),
    ]);
    const refresh = el('button', { class: 'btn small', text: '刷新' });
    const wrap = el('div');
    box.append(el('div', { class: 'row', style: 'margin-bottom:12px' }, [el('h3', { class: 'grow', text: '文件管理' }), scopeSel, statusSel, refresh]), wrap);
    const load = async () => {
      try {
        const d = await api(`/api/admin/files?scope=${scopeSel.value}&status=${statusSel.value}`);
        wrap.innerHTML = '';
        const groups = new Map();
        for (const f of d.files) {
          if (!groups.has(f.groupLabel)) groups.set(f.groupLabel, []);
          groups.get(f.groupLabel).push(f);
        }
        if (!d.files.length) {
          wrap.append(el('div', { class: 'empty', text: '暂无文件' }));
          return;
        }
        for (const [label, files] of groups) {
          wrap.append(el('div', { class: 'group-title', text: label }));
          const table = el('table', {}, [
            el('thead', {}, [el('tr', {}, ['文件名', '上传者', '过期时间', '状态', '删除原因', '大小', '上传时间', '操作'].map((t) => el('th', { text: t })))]),
          ]);
          for (const f of files) {
            const tr = el('tr', {}, [
              el('td', { text: f.filename, title: f.filename }),
              el('td', { text: f.uploader }),
              el('td', { text: fmtTime(f.expiresAt) }),
              el('td', {}, [el('span', { class: `badge ${f.status === 'active' ? 'ok' : 'danger'}`, text: f.status === 'active' ? '正常' : '已删除' })]),
              el('td', { text: f.deleteReasonText }),
              el('td', { text: f.sizeText }),
              el('td', { text: fmtTime(f.createdAt) }),
              el('td', {}, [
                f.status === 'active'
                  ? el('button', {
                      class: 'btn danger small',
                      text: '删除',
                      onClick: async () => {
                        if (!(await confirmDialog('删除文件', `确定删除 ${f.filename} 吗？物理文件将被清除，数据库保留记录。`, '删除', true))) return;
                        try {
                          await api(`/api/admin/files/${f.id}/delete`, { method: 'POST', body: {} });
                          load();
                        } catch (e) { toast(e.message, 'error'); }
                      },
                    })
                  : '',
              ]),
            ]);
            table.append(el('tbody', {}, [tr]));
          }
          wrap.append(el('div', { class: 'table-scroll' }, [table]));
        }
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    scopeSel.addEventListener('change', load);
    statusSel.addEventListener('change', load);
    refresh.addEventListener('click', load);
    await load();
  }

  async function roomsView(box) {
    const refresh = el('button', { class: 'btn small', text: '刷新' });
    const wrap = el('div');
    box.append(
      el('div', { class: 'row', style: 'margin-bottom:12px' }, [el('h3', { class: 'grow', text: '房间管理' }), refresh]),
      wrap
    );
    const load = async () => {
      try {
        const d = await api('/api/admin/rooms');
        wrap.innerHTML = '';
        if (!d.rooms.length) {
          wrap.append(el('div', { class: 'empty', text: '暂无房间' }));
          return;
        }
        const table = el('table', {}, [
          el('thead', {}, [el('tr', {}, ['房间号', '房间名', '房主', '状态', '其他用户保留', '单文件上限', '房间容量', '密码', '操作'].map((t) => el('th', { text: t })))]),
        ]);
        for (const r of d.rooms) {
          const tr = el('tr', {}, [
            el('td', { text: r.number }),
            el('td', { text: r.title || '-' }),
            el('td', { text: r.ownerName }),
            el('td', {}, [el('span', { class: `badge ${r.status === 'active' ? 'ok' : r.status === 'pending' ? 'warn' : 'muted'}`, text: r.status === 'active' ? '可用' : r.status === 'pending' ? '待审批' : '已销毁' })]),
            el('td', { text: r.maxRetentionDays ? `${r.maxRetentionDays} 天` : '永久' }),
            el('td', { text: `${Math.round(r.maxFileSize / 1024 ** 3)} GB` }),
            el('td', { text: r.roomCapacityBytes ? `${Math.round(r.roomCapacityBytes / 1024 ** 3)} GB` : '不限' }),
            el('td', { text: r.hasPassword ? '有' : '无' }),
            el('td', { class: 'row', style: 'gap:6px' }, [
              r.status === 'active'
                ? el('button', { class: 'btn secondary small', text: '设置', onClick: () => editRoom(r) })
                : '',
              el('button', {
                class: 'btn danger small',
                text: '销毁',
                onClick: async () => {
                  if (!(await confirmDialog('销毁房间', `确定销毁房间 ${r.number} 吗？房间内所有文件将被删除。`, '销毁', true))) return;
                  try {
                    await api(`/api/rooms/${encodeURIComponent(r.number)}`, { method: 'DELETE' });
                    load();
                  } catch (e) { toast(e.message, 'error'); }
                },
              }),
            ]),
          ]);
          table.append(el('tbody', {}, [tr]));
        }
        wrap.append(el('div', { class: 'table-scroll' }, [table]));
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    function editRoom(r) {
      const titleInput = el('input', { type: 'text', value: r.title || '' });
      const keepPw = el('input', { type: 'checkbox', checked: true });
      const pwInput = el('input', { type: 'password', placeholder: '新密码' });
      const maxRetSel = el('select', {}, [
        el('option', { value: '', text: '永久（不限制）' }),
        el('option', { value: '1', text: '1 天' }),
        el('option', { value: '7', text: '7 天' }),
        el('option', { value: '30', text: '30 天' }),
      ]);
      maxRetSel.value = r.maxRetentionDays ? String(r.maxRetentionDays) : '';
      const maxSizeInput = el('input', { type: 'number', value: Math.round(r.maxFileSize / 1024 ** 3), min: 1, max: 10, step: 1 });
      const capacityInput = el('input', {
        type: 'number',
        value: r.roomCapacityBytes ? Math.round(r.roomCapacityBytes / 1024 ** 3) : '',
        min: 1,
        placeholder: '留空 = 不限制',
        step: 1,
      });
      const permOptions = [
        el('option', { value: 'all', text: '所有人' }),
        el('option', { value: 'owner', text: '仅自己' }),
        el('option', { value: 'registered', text: '仅登录用户' }),
      ];
      const uploadPermSel = el('select', {}, permOptions.map((o) => o.cloneNode(true)));
      const downloadPermSel = el('select', {}, permOptions.map((o) => o.cloneNode(true)));
      uploadPermSel.value = r.uploadPermission || 'all';
      downloadPermSel.value = r.downloadPermission || 'all';
      const m = modal({
        title: `房间设置：${r.number}`,
        body: el('div', {}, [
          el('div', { class: 'form-group' }, [el('label', { text: '房间名' }), titleInput]),
          el('div', { class: 'form-group' }, [el('label', {}, [keepPw, ' 保持当前密码不变']), pwInput]),
          el('div', { class: 'form-group' }, [el('label', { text: '其他用户上传文件最长保留时间' }), maxRetSel]),
          el('div', { class: 'form-group' }, [el('label', { text: '单文件最大上传大小（GB，1-10）' }), maxSizeInput]),
          el('div', { class: 'form-group' }, [el('label', { text: '房间文件总容量（GB，可留空）' }), capacityInput]),
          el('div', { class: 'form-group' }, [el('label', { text: '允许其他人上传' }), uploadPermSel]),
          el('div', { class: 'form-group' }, [el('label', { text: '允许其他人下载' }), downloadPermSel]),
        ]),
        actions: [
          { label: '取消', class: 'secondary', onClick: () => m.close() },
          {
            label: '保存',
            class: 'ok',
            onClick: async () => {
              try {
                await api(`/api/rooms/${encodeURIComponent(r.number)}`, {
                  method: 'PUT',
                  body: {
                    title: titleInput.value,
                    ...(keepPw.checked ? {} : { password: pwInput.value }),
                    maxRetentionDays: maxRetSel.value === '' ? null : Number(maxRetSel.value),
                    maxFileSize: Math.round(Number(maxSizeInput.value) || 10) * 1024 ** 3,
                    roomCapacityBytes: capacityInput.value === '' ? null : Math.round(Number(capacityInput.value)) * 1024 ** 3,
                    uploadPermission: uploadPermSel.value,
                    downloadPermission: downloadPermSel.value,
                  },
                });
                m.close();
                load();
                toast('房间设置已保存');
              } catch (e) { toast(e.message, 'error'); }
            },
          },
        ],
      });
    }
    refresh.addEventListener('click', load);
    await load();
  }

  async function themesView(box) {
    const wrap = el('div');
    const fileInput = el('input', { type: 'file', accept: '.zip', class: 'hidden' });
    const refresh = el('button', { class: 'btn small', text: '刷新' });
    const dl = el('button', { class: 'btn secondary small', text: '下载默认模板' });
    const upload = el('button', { class: 'btn small', text: '上传公共主题' });
    box.append(
      el('div', { class: 'row', style: 'margin-bottom:12px' }, [el('h3', { class: 'grow', text: '主题管理' }), dl, upload, fileInput, refresh]),
      wrap
    );

    const load = async () => {
      try {
        const d = await api('/api/admin/themes');
        wrap.innerHTML = '';
        const globalTheme = d.globalTheme || 'default';
        const gp = parseTheme(globalTheme);
        const globalThemeName = globalTheme === 'default'
          ? '默认主题（内置）'
          : (d.themes.find((t) => t.source === gp.source && t.name === gp.name) || { name: globalTheme }).name;
        wrap.append(el('div', { class: 'row muted', style: 'margin-bottom:10px' }, [
          el('span', { text: `当前全局主题：${globalThemeName}` }),
          el('span', { class: 'small', text: '在主题预览窗口中可切换全局主题' }),
        ]));
        const grid = el('div', { class: 'theme-list' });
        for (const t of d.themes) {
          const pref = t.source === 'default' ? 'default' : `${t.source}:${t.name}`;
          const isGlobal = globalTheme === pref;
          const delBtn = t.deletable ? el('button', {
            class: 'theme-del',
            title: '删除公共主题',
            text: '×',
            onClick: async (e) => {
              e.stopPropagation();
              if (!(await confirmDialog('删除公共主题', `确定删除主题 ${t.name} 吗？所有用户将无法再使用。`, '删除', true))) return;
              try {
                await api(`/api/admin/themes/${encodeURIComponent(t.name)}`, { method: 'DELETE' });
                load();
              } catch (e) { toast(e.message, 'error'); }
            },
          }) : null;
          const card = el('div', { class: `card theme-card${isGlobal ? ' selected' : ''}` }, [
            ...(delBtn ? [delBtn] : []),
            el('div', { class: 'theme-card-name', style: 'font-weight:600', text: `${t.name}${t.source === 'default' ? '（默认）' : ''}${isGlobal ? '（当前全局）' : ''}` }),
            el('div', { class: 'muted', text: `版本 ${t.version} · 作者 ${t.author}` }),
            el('div', { class: 'muted small', text: t.description || '' }),
          ]);
          card.addEventListener('click', () => {
            const m = openThemePreview(t, t, {
              actions: isGlobal ? [] : [{
                label: '设为全局主题',
                class: 'ok',
                onClick: async () => {
                  if (!(await confirmDialog('设为全局主题', '将为所有人更换默认主题，是否确认？', '确认', true))) return;
                  try {
                    await api('/api/admin/themes/global', { method: 'POST', body: { theme: pref } });
                    m.close();
                    load();
                    toast('已保存全局主题');
                  } catch (e) { toast(e.message, 'error'); }
                },
              }],
            });
          });
          grid.append(card);
        }
        wrap.append(grid);
      } catch (e) {
        toast(e.message, 'error');
      }
    };

    dl.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/admin/themes/template', { headers: authHeaders() });
        if (!res.ok) throw new Error('模板下载失败');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: 'webdrop-theme-template.zip' });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (e) { toast(e.message, 'error'); }
    });
    upload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      try {
        const res = await fetch('/api/admin/themes/upload', {
          method: 'POST',
          headers: { ...authHeaders(), 'x-file-name': encodeURIComponent(f.name) },
          body: f,
        });
        const text = await res.text();
        let d;
        try { d = JSON.parse(text); } catch { d = { error: '上传失败' }; }
        if (!res.ok) throw new Error(d.error || '上传失败');
        toast('公共主题上传成功');
        load();
      } catch (e) { toast(e.message, 'error'); }
    });
    refresh.addEventListener('click', load);
    await load();
  }

  async function usersView(box) {
    const typeTabs = el('div', { class: 'tabs' }, [
      el('div', { class: 'tab active', text: '注册用户', onClick: () => switchType('registered') }),
      el('div', { class: 'tab', text: '临时用户', onClick: () => switchType('temp') }),
    ]);
    const clearWrap = el('div', { style: 'margin-bottom:10px' });
    const wrap = el('div');
    box.append(typeTabs, clearWrap, wrap);
    let type = 'registered';

    function switchType(t) {
      type = t;
      typeTabs.children[0].classList.toggle('active', t === 'registered');
      typeTabs.children[1].classList.toggle('active', t === 'temp');
      clearWrap.innerHTML = '';
      if (t === 'temp') {
        clearWrap.append(
          el('button', {
            class: 'btn danger small',
            text: '一键清理全部临时用户',
            onClick: async () => {
              if (!(await confirmDialog('清理全部临时用户', '将把全部临时用户设为已删除，其名下文件将被清除。此操作不可恢复，确定继续吗？', '全部清理', true))) return;
              try {
                const r = await api('/api/admin/users/temp-clear', { method: 'POST', body: {} });
                toast(`已清理 ${r.count} 个临时用户`);
                load();
              } catch (e) { toast(e.message, 'error'); }
            },
          })
        );
      }
      load();
    }

    async function load() {
      try {
        const d = await api(`/api/admin/users?type=${type}`);
        wrap.innerHTML = '';
        if (!d.users.length) {
          wrap.append(el('div', { class: 'empty', text: '暂无用户' }));
          return;
        }
        const table = el('table', {}, [
          el('thead', {}, [el('tr', {}, ['用户名/昵称', type === 'registered' ? '邮箱 / QQ' : 'UUID', '等级', '状态', '持久空间', '注册时间', '操作'].map((t) => el('th', { text: t })))]),
        ]);
        for (const u of d.users) {
          const tr = el('tr');
          tr.append(
            el('td', { text: u.displayName }),
            el('td', { text: type === 'registered' ? `${u.email || '-'} / ${u.qq || '-'}` : u.uuid }),
            el('td', { text: type === 'registered' ? `V${u.level}` : '-' }),
            el('td', {}, [el('span', { class: `badge ${u.status === 'normal' ? 'ok' : u.status === 'banned' ? 'danger' : 'muted'}`, text: { normal: '正常', banned: '已封禁', deleted: '已删除', pending: '待审核' }[u.status] || u.status })]),
            el('td', { text: `${fmtBytes(u.usedBytes)} / ${fmtBytes(u.quotaBytes)}` }),
            el('td', { text: fmtTime(u.createdAt) }),
            el('td', { class: 'row', style: 'gap:6px' })
          );
          const actions = tr.lastChild;
          if (u.status !== 'deleted') {
            if (type === 'registered') {
              const lv = el('select', {}, [0, 1, 2, 3, 4, 5, 6].map((l) => el('option', { value: l, text: `V${l}`, selected: l === u.level })));
              actions.append(
                el('button', {
                  class: 'btn ok small',
                  text: '设为VIP',
                  onClick: async () => {
                    try {
                      await api(`/api/admin/users/${u.id}/status`, { method: 'POST', body: { status: 'normal', level: Number(lv.value) } });
                      load();
                    } catch (e) { toast(e.message, 'error'); }
                  },
                }),
                lv
              );
            }
            actions.append(
              el('button', {
                class: 'btn small',
                text: u.status === 'banned' ? '解封' : '封禁',
                onClick: async () => {
                  try {
                    await api(`/api/admin/users/${u.id}/status`, { method: 'POST', body: { status: u.status === 'banned' ? 'normal' : 'banned' } });
                    load();
                  } catch (e) { toast(e.message, 'error'); }
                },
              })
            );
          }
          actions.append(
            el('button', {
              class: 'btn danger small',
              text: '删除',
              onClick: async () => {
                if (!(await confirmDialog('删除用户', `确定删除用户 ${u.displayName} 吗？删除后不可恢复，其名下文件将被清除，用户名可重新注册。`, '删除', true))) return;
                try {
                  await api(`/api/admin/users/${u.id}/status`, { method: 'POST', body: { status: 'deleted' } });
                  load();
                } catch (e) { toast(e.message, 'error'); }
              },
            })
          );
          table.append(el('tbody', {}, [tr]));
        }
        wrap.append(el('div', { class: 'table-scroll' }, [table]));
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    await load();
  }

  async function approvalsView(box) {
    const wrap = el('div');
    box.append(el('h3', { style: 'margin-bottom:12px', text: '审批中心' }), wrap);
    const load = async () => {
      try {
        const d = await api('/api/admin/approvals');
        wrap.innerHTML = '';
        wrap.append(el('div', { class: 'group-title', text: '注册申请' }));
        if (!d.registrations.length) wrap.append(el('div', { class: 'muted', text: '暂无待审核注册' }));
        for (const r of d.registrations) {
          const card = el('div', { class: 'card row' }, [
            el('div', { class: 'grow' }, [
              el('div', { text: `${r.username}${r.nickname ? '（' + r.nickname + '）' : ''}` }),
              el('div', { class: 'muted', text: `邮箱：${r.email || '-'} · QQ：${r.qq || '-'} · 提交于 ${fmtTime(r.created_at)}` }),
            ]),
            el('button', { class: 'btn ok small', text: '通过', onClick: async () => { await act(`/api/admin/approvals/registrations/${r.id}`, 'approve'); } }),
            el('button', { class: 'btn danger small', text: '拒绝', onClick: async () => { await act(`/api/admin/approvals/registrations/${r.id}`, 'reject'); } }),
          ]);
          wrap.append(card);
        }
        wrap.append(el('div', { class: 'group-title', text: '自定义房间号申请' }));
        if (!d.roomRequests.length) wrap.append(el('div', { class: 'muted', text: '暂无待审核房间号' }));
        for (const r of d.roomRequests) {
          const card = el('div', { class: 'card row' }, [
            el('div', { class: 'grow' }, [
              el('div', { text: `房间号：${r.requested_number} · 申请人：${r.owner_nickname || r.owner_username}` }),
              el('div', { class: 'muted', text: r.title ? `标题：${r.title}` : '' }),
            ]),
            el('button', { class: 'btn ok small', text: '通过', onClick: async () => { await act(`/api/admin/approvals/rooms/${r.id}`, 'approve'); } }),
            el('button', { class: 'btn danger small', text: '拒绝', onClick: async () => { await act(`/api/admin/approvals/rooms/${r.id}`, 'reject'); } }),
          ]);
          wrap.append(card);
        }
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    async function act(path, action) {
      try {
        await api(path, { method: 'POST', body: { action } });
        load();
      } catch (e) { toast(e.message, 'error'); }
    }
    await load();
  }

  async function settingsView(box) {
    const d = await api('/api/admin/settings');
    const maxGb = el('input', { type: 'number', value: (d.maxUploadBytes / 1024 ** 3).toFixed(1), min: 0.1, step: 0.1 });
    const quotaGb = el('input', { type: 'number', value: d.defaultQuotaGb, min: 1 });
    const storagePath = el('input', { type: 'text', value: d.storagePath });
    const saveBtn = el('button', { class: 'btn', text: '保存设置' });
    const msg = el('div', { class: 'muted', style: 'margin-top:8px' });
    const form = el('div', { class: 'panel' }, [
      el('h3', { style: 'margin-bottom:12px', text: '全局设置' }),
      el('div', { class: 'form-group' }, [el('label', { text: '全局最大上传大小（GB，默认 10，对全局生效）' }), maxGb]),
      el('div', { class: 'form-group' }, [el('label', { text: '持久存储配额基准（GB，V0 用户；VIP 每级 +50G）' }), quotaGb]),
      el('div', { class: 'form-group' }, [el('label', { text: '文件存放路径（映射到宿主机）' }), storagePath]),
      saveBtn,
      msg,
    ]);
    const cred = el('div', { class: 'panel' }, [
      el('h3', { style: 'margin-bottom:12px', text: '修改管理员账号（当前：' + d.adminUsername + '）' }),
      el('div', { class: 'form-group' }, [el('label', { text: '当前密码' }), el('input', { id: 'c-pass', type: 'password' })]),
      el('div', { class: 'form-group' }, [el('label', { text: '新用户名（留空不修改）' }), el('input', { id: 'c-user' })]),
      el('div', { class: 'form-group' }, [el('label', { text: '新密码（留空不修改）' }), el('input', { id: 'c-new', type: 'password' })]),
      el('button', { class: 'btn', text: '更新账号', onClick: async () => {
        try {
          await api('/api/admin/change-credentials', {
            method: 'POST',
            body: { currentPassword: $('#c-pass').value, newUsername: $('#c-user').value, newPassword: $('#c-new').value },
          });
          toast('账号已更新，请重新登录');
          localStorage.removeItem('wd_token');
          localStorage.removeItem('wd_user');
          location.hash = '#/login';
          window.dispatchEvent(new Event('wd-refresh'));
        } catch (e) { toast(e.message, 'error'); }
      } }),
    ]);
    box.append(form, cred);
    saveBtn.addEventListener('click', async () => {
      try {
        const r = await api('/api/admin/settings', {
          method: 'PUT',
          body: {
            maxUploadBytes: Math.round(Number(maxGb.value) * 1024 ** 3),
            defaultQuotaGb: Number(quotaGb.value),
            storagePath: storagePath.value.trim(),
          },
        });
        msg.textContent = r.message || '已保存';
      } catch (e) { msg.textContent = e.message; }
    });
  }
}
