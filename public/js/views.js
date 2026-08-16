import { el, $, toast, fmtBytes, fmtTime, confirmDialog, modal } from './util.js';
import { api, uploadWithProgress, downloadBlob } from './api.js';
import { ChatView, openImageViewer, openVoicePlayer, mediaUrl } from './chat.js';
import { SessionRTC, BigTransfer, CHUNK, ACK_EVERY, detectNetworkInfo, hasMatchingSubnet } from './rtc.js';
import { listThemes, uploadTheme, deleteTheme, applyTheme, parseTheme, openThemePreview } from './theme.js';
import { store, ws, myUserId } from './state.js';

const STAGING_LIMIT = 10 * 1024 * 1024;

/** 标题超宽时可左右拖动查看完整内容 */
function makeDragScroll(container) {
  const inner = container.firstElementChild;
  if (!inner) return;
  let offset = 0;
  let drag = null;
  const updateMask = () => {
    const max = Math.max(0, inner.scrollWidth - container.clientWidth);
    container.classList.toggle('can-right', max > 0 && offset > -max);
    container.classList.toggle('can-left', offset < 0);
  };
  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (inner.scrollWidth <= container.clientWidth) return; // 未超宽不启用拖动
    drag = { x: e.clientX, base: offset };
    container.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  container.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const max = Math.max(0, inner.scrollWidth - container.clientWidth);
    offset = Math.min(0, Math.max(-max, drag.base + (e.clientX - drag.x)));
    inner.style.transform = `translateX(${offset}px)`;
    updateMask();
  });
  const end = () => { drag = null; };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
  updateMask();
}

export function viewHome(container) {
  container.innerHTML = '';
  const root = el('div', { class: 'container home-root' });

  // 左侧：本机身份 + 搜索/排序 + 在线用户
  const myNameSpan = el('span', { class: 'my-name', text: '连接中…' });
  const tempLogoutBtn = el('button', { class: 'btn danger small hidden', text: '注销' });
  const myBanner = el('div', { class: 'my-banner' }, [
    el('span', { class: 'muted', text: '我的昵称：' }),
    myNameSpan,
    el('span', { class: 'grow' }),
    tempLogoutBtn,
  ]);
  const searchInput = el('input', { type: 'text', placeholder: '搜索用户名…' });
  const sortSelect = el('select', {}, [
    el('option', { value: 'order', text: '上线顺序' }),
    el('option', { value: 'name', text: '按名称' }),
  ]);
  const myDeviceList = el('div', { class: 'user-list device-list' });
  const myDeviceTitle = el('div', { class: 'muted', text: '在线设备' });
  const userList = el('div', { class: 'user-list' });
  const side = el('div', { class: 'side-panel panel' }, [
    myBanner,
    myDeviceTitle,
    myDeviceList,
    el('div', { class: 'row search-row' }, [searchInput, sortSelect]),
    el('div', { class: 'muted', text: '在线用户' }),
    userList,
  ]);

  // 空闲时右侧显示请求列表
  const reqList = el('div', { class: 'request-list hidden' });
  const reqHint = el('div', { class: 'empty', text: '点击在线用户，向对方发起点对点传输' });
  const requestsPanel = el('div', { class: 'panel request-panel' }, [
    el('div', { class: 'muted', style: 'margin-bottom:8px', text: '收到的会话请求' }),
    reqList,
    reqHint,
  ]);

  // 聊天（常驻实例，按状态挂载到不同布局）
  const chat = new ChatView({
    title: 'WebDrop 点对点',
    onText: (text) => sendText(text),
    onFiles: (files) => sendFiles(files),
    onVoice: (blob) => sendFiles([blob]),
    onFilePick: (active) => {
      ws.setFilePick(active);
      if (!active) window.dispatchEvent(new Event('wd-resume')); // 选完文件回到聊天：立即同步对方在线状态与错过的消息
    },
  });
  chat.onCancelTransfer = (tid) => cancelTransfer(tid);
  chat.setInputEnabled(false);
  const backBtn = el('button', { class: 'btn secondary small', text: '← 返回列表' });
  chat.head.append(backBtn);
  const layout = el('div');
  root.append(layout);
  // 手机端：固定的"收到的会话请求"按钮（桌面端隐藏）
  const mobileReqBtn = el('button', { class: 'mobile-req-btn request-alert', text: '收到会话请求 [0]' });
  mobileReqBtn.addEventListener('click', openRequestsModal);
  root.append(mobileReqBtn);
  container.append(root);

  function activeSession() {
    return store.sessions.get(store.activeSessionId) || null;
  }

  function renderUsers() {
    renderMyDevices();
    const q = searchInput.value.trim().toLowerCase();
    const byName = sortSelect.value === 'name';
    let users = store.onlineDevices.filter((d) => d.userId !== myUserId());
    if (q) users = users.filter((u) => u.name.toLowerCase().includes(q));
    users = byName
      ? [...users].sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      : [...users].sort((a, b) => a.onlineSince.localeCompare(b.onlineSince));
    userList.innerHTML = '';
    if (!users.length) {
      userList.append(el('div', { class: 'empty', text: '暂无其他在线用户' }));
      return;
    }
    for (const u of users) {
      const item = el('div', { class: `user-item${u.busy ? ' busy' : ''}` }, [
        el('span', { class: 'dot' }),
        el('span', { class: 'name', text: u.name }),
        u.busy ? el('span', { class: 'badge warn', text: '繁忙' }) : '',
      ]);
      item.addEventListener('click', () => {
        if (u.busy) return toast('对方正忙，无法发起会话');
        startSession(u);
      });
      userList.append(item);
    }
  }

  function renderMyDevices() {
    const mine = store.onlineDevices
      .filter((d) => d.userId === myUserId())
      .sort((a, b) => a.onlineSince.localeCompare(b.onlineSince));
    myDeviceList.innerHTML = '';
    if (!mine.length) {
      myDeviceTitle.textContent = '在线设备';
      myDeviceList.append(el('div', { class: 'empty', text: '暂无在线设备' }));
      return;
    }
    const currentIdx = mine.findIndex((d) => d.key === store.myDeviceKey);
    myDeviceTitle.textContent = `在线设备 [当前：设备${Math.max(currentIdx + 1, 1)}]`;
    mine.forEach((d, i) => {
      const isCurrent = d.key === store.myDeviceKey;
      const badgeText = isCurrent ? '本机' : d.busy ? `[设备${i + 1}]（忙）` : `[设备${i + 1}]`;
      const shortId = `…${d.deviceId.slice(-4)}`;
      const uuidText = el('span', { class: 'uuid-text', text: isCurrent ? shortId : d.deviceId });
      const uuidWrap = el('div', { class: 'uuid-scroll' }, [uuidText]);
      const item = el('div', { class: `user-item${d.busy ? ' busy' : ''}` }, [
        el('span', { class: 'dot' }),
        uuidWrap,
        el('span', { class: `badge ${isCurrent ? 'ok' : d.busy ? 'warn' : 'muted'}`, text: badgeText }),
      ]);
      const refreshMarquee = () => {
        if (uuidText.scrollWidth > uuidWrap.clientWidth) {
          uuidWrap.classList.add('marquee');
          uuidText.style.setProperty('--dist', `${uuidText.scrollWidth - uuidWrap.clientWidth}px`);
        } else {
          uuidWrap.classList.remove('marquee');
        }
      };
      requestAnimationFrame(() => {
        if (!isCurrent) refreshMarquee();
      });
      if (isCurrent) {
        // 本机：默认显示尾号 4 位，点击切换完整 UUID（溢出时滚动）
        item.addEventListener('click', () => {
          const expanded = uuidWrap.classList.toggle('expanded');
          uuidText.textContent = expanded ? d.deviceId : shortId;
          requestAnimationFrame(() => {
            if (expanded) refreshMarquee();
            else uuidWrap.classList.remove('marquee');
          });
        });
      } else {
        item.addEventListener('click', () => {
          if (d.busy) return toast('该设备正忙，无法发起会话');
          startSession(d);
        });
      }
      myDeviceList.append(item);
    });
  }

  function renderRequests() {
    // 手机端固定按钮始终同步（含请求清空场景）
    const n = store.requests.length;
    mobileReqBtn.textContent = `收到会话请求 [${n}]`;
    mobileReqBtn.classList.toggle('has-req', n > 0);
    reqList.innerHTML = '';
    if (!store.requests.length) {
      reqList.classList.add('hidden');
      reqHint.classList.remove('hidden');
      return;
    }
    reqList.classList.remove('hidden');
    reqHint.classList.add('hidden');
    if (!window.matchMedia('(max-width: 768px)').matches) {
      // 桌面端：直接显示列表
      for (const r of store.requests) {
        reqList.append(
          el('div', { class: 'request-item' }, [
            el('span', { class: 'grow', text: `${r.from.name} 请求与你传输` }),
            el('button', { class: 'btn ok small', text: '接受', onClick: () => acceptRequest(r) }),
            el('button', { class: 'btn secondary small', text: '拒绝', onClick: () => declineRequest(r) }),
          ])
        );
      }
    }
  }

  function openRequestsModal() {
    const body = el('div');
    const render = () => {
      body.innerHTML = '';
      if (!store.requests.length) {
        mm.close();
        return;
      }
      for (const r of store.requests) {
        body.append(
          el('div', { class: 'request-item' }, [
            el('span', { class: 'grow', text: `${r.from.name} 请求与你传输` }),
            el('button', { class: 'btn ok small', text: '接受', onClick: () => { mm.close(); acceptRequest(r); } }),
            el('button', { class: 'btn secondary small', text: '拒绝', onClick: () => { declineRequest(r); render(); } }),
          ])
        );
      }
    };
    const mm = modal({
      title: '收到的会话请求',
      body,
      actions: [{ label: '关闭', class: 'secondary', onClick: () => mm.close() }],
    });
    render();
  }

  async function acceptRequest(r) {
    const session = {
      id: r.sessionId,
      peer: r.from,
      rtc: null,
      relay: false,
      active: true,
      ended: false,
      net: [],
      peerNet: r.net || [],
      lan: false,
      ready: false,
      messages: [],
      lastMsgId: 0,
      seenIds: new Set(),
      seenMids: new Set(),
      transfers: new Map(),
    };
    store.sessions.set(session.id, session);
    store.requests = store.requests.filter((x) => x.sessionId !== r.sessionId);
    const net = await detectNetworkInfo();
    session.net = net || [];
    session.lan = hasMatchingSubnet(session.net, session.peerNet);
    session.rtc = new SessionRTC({
      sessionId: session.id,
      ws,
      onState: () => {},
      onFrame: (obj, buf) => onRtcFrame(session, obj, buf),
      lan: session.lan,
      peerSubnets: session.peerNet.map((x) => x.subnet).filter(Boolean),
      onLan: (info) => onLanConfirmed(session, info),
    });
    const answer = await session.rtc.acceptOffer(r.offer);
    if (session.ended) return; // 对方在等待期间取消了请求，不再进入聊天窗口
    ws.send({ type: 'sessionAccept', sessionId: session.id, answer, net: session.net });
    if (session.lan) {
      pushMessage(session, { mine: true, type: 'system', content: '检测到同一局域网，已优先使用局域网地址直连' });
    }
    pushMessage(session, { mine: true, type: 'system', content: '已接受会话请求' });
    showSession(session.id);
    renderRequests();
  }

  function pushMessage(session, desc) {
    session.messages.push(desc);
    if (desc.clientId) session.seenMids.add(desc.clientId);
    if (desc.messageId) {
      session.seenIds.add(desc.messageId);
      session.lastMsgId = Math.max(session.lastMsgId || 0, desc.messageId);
    }
    if (store.activeSessionId === session.id) chat.addMessage(desc);
  }

  // 选文件/离开期间回到前台：检查对方在线状态并补拉错过的消息
  async function resumeSessionSync() {
    const s = store.sessions.get(store.activeSessionId);
    if (!s || s.ended) return;
    const online = store.onlineDevices.some((d) => d.key === s.peer.key);
    const sub = document.querySelector('#chat-sub');
    if (sub) sub.textContent = online ? '对方在线' : '对方已离线';
    try {
      const d = await api(`/api/sessions/${encodeURIComponent(s.id)}/messages?after=${s.lastMsgId || 0}`);
      let cursor = s.lastMsgId || 0;
      for (const m of d.messages || []) {
        cursor = Math.max(cursor, m.id);
        if (s.seenIds.has(m.id)) continue; // 已经在聊天中渲染过的消息不再重复
        if (m.id <= (s.lastMsgId || 0)) continue;
        if (m.client_id && s.seenMids.has(m.client_id)) continue; // 直连已经收到的消息不再重复渲染
        const mine = m.sender_id === myUserId();
        pushMessage(s, {
          mine,
          sender: mine ? '我' : m.sender_name || s.peer.name,
          type: m.type === 'voice' ? 'voice' : m.type === 'image' ? 'image' : m.type === 'video' ? 'video' : m.type === 'file' ? 'file' : 'text',
          content: m.content,
          ts: m.created_at,
          messageId: m.id,
          clientId: m.client_id,
        });
      }
      s.lastMsgId = cursor;
    } catch { /* 网络异常静默，下次回到前台再同步 */ }
  }

  let shownSessionId = null;

  function updateMyName() {
    const u = store.user;
    myNameSpan.textContent = u?.nickname || u?.username || u?.uuid || '连接中…';
    tempLogoutBtn.classList.toggle('hidden', !(u && u.role === 'temp' && !store.token));
  }
  updateMyName();
  ws.on('hello', updateMyName);

  tempLogoutBtn.addEventListener('click', async () => {
    if (!(await confirmDialog('注销临时账号', '注销后当前 UUID 将被释放，名下文件将被清除，页面将自动分配新的临时身份。确定注销吗？', '注销', true))) return;
    try {
      await api('/api/auth/temp-logout', { method: 'POST' });
      localStorage.removeItem('wd_temp');
      location.reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  function renderLayout() {
    const s = store.activeSessionId ? store.sessions.get(store.activeSessionId) : null;
    const mobile = window.matchMedia('(max-width: 768px)').matches;
    const fullChat = s && (s.active || (mobile && !s.ended));
    mobileReqBtn.classList.toggle('hidden', !!(s && s.active));
    layout.innerHTML = '';
    if (fullChat) {
      // 建立连接后：只显示聊天框
      layout.classList.remove('home-layout');
      layout.classList.add('chat-only-wrap');
      backBtn.textContent = s.active ? '← 返回列表' : '取消请求';
      layout.append(chat.root);
    } else {
      layout.classList.remove('chat-only-wrap');
      layout.classList.add('home-layout');
      layout.append(side);
      if (s && !s.ended) {
        // 等待对方接受：聊天区显示挂起的会话
        backBtn.textContent = '取消请求';
        layout.append(chat.root);
      } else {
        layout.append(requestsPanel);
        renderRequests();
      }
    }
  }

  function showSession(sid) {
    store.activeSessionId = sid;
    const s = store.sessions.get(sid);
    chat.setInputEnabled(!!(s && s.active && s.ready));
    if (shownSessionId !== sid) {
      chat.clear();
      shownSessionId = sid;
      if (s) {
        chat.head.querySelector('.grow').textContent = `与 ${s.peer.name} 的会话`;
        const mode = s.relay ? '服务器中转' : 'P2P 直连（IPv6 优先）';
        chat.setSub(s.lan ? `同一局域网 · ${mode}` : mode);
        for (const m of s.messages) chat.addMessage(m);
      }
    }
    renderLayout();
    renderUsers();
  }

  function exitSessionView() {
    store.activeSessionId = null;
    shownSessionId = null;
    chat.clear();
    chat.setInputEnabled(false);
    renderLayout();
    renderUsers();
  }

  function onLanConfirmed(session, info) {
    if (session.lan) return;
    session.lan = true;
    if (session.rtc) session.rtc.lan = true;
    pushMessage(session, { mine: true, type: 'system', content: '检测到同一局域网，已优先使用局域网地址直连' });
    if (store.activeSessionId === session.id) {
      const mode = session.relay ? '服务器中转' : 'P2P 直连（IPv6 优先）';
      chat.setSub(`同一局域网 · ${mode}`);
    }
  }

  function endSessionLocally(s) {
    s.ended = true;
    s.active = false;
    ws.send({ type: 'sessionEnd', sessionId: s.id });
    try { s.rtc?.close(); } catch { /* ignore */ }
    for (const tid of s.transfers.keys()) chat.removeTransfer(tid);
    exitSessionView();
  }

  function cancelTransfer(transferId) {
    const s = activeSession();
    if (!s) return;
    const t = s.transfers.get(transferId);
    if (!t) return;
    if (t.cancel) {
      // 发送端取消
      t.cancel();
      ws.send({ type: 'fileCancel', sessionId: s.id, transferId });
      chat.setTransferCanceled(transferId, `${t.file.name} · 已取消`);
      s.transfers.delete(transferId);
      pushMessage(s, { mine: true, type: 'system', content: '已取消传输' });
    } else {
      // 接收端取消
      cancelReceive(s, transferId);
    }
  }

  function cancelReceive(s, transferId) {
    const t = s.transfers.get(transferId);
    if (!t) return;
    t.canceled = true;
    if (t.writable) {
      try { t.writable.close(); } catch { /* ignore */ }
    }
    recvState.delete(`${s.id}:${transferId}`);
    s.transfers.delete(transferId);
    chat.setTransferCanceled(transferId, '已取消接收');
    ws.send({ type: 'fileCancel', sessionId: s.id, transferId });
    pushMessage(s, { mine: true, type: 'system', content: '已取消接收' });
  }

  backBtn.addEventListener('click', async () => {
    const s = store.activeSessionId ? store.sessions.get(store.activeSessionId) : null;
    if (!s) return;
    if (s.active && !(await confirmDialog('结束会话', '确定结束当前会话并返回列表吗？', '结束会话', true))) return;
    endSessionLocally(s);
  });

  async function startSession(u) {
    // 已有会话则切换（按设备）
    for (const [sid, s] of store.sessions) {
      if (s.peer.key === u.key && !s.ended) return showSession(sid);
    }
    const session = {
      id: `L${Date.now().toString(36)}`,
      peer: { key: u.key, userId: u.userId, name: u.name },
      rtc: null,
      relay: false,
      active: false,
      ended: false,
      net: [],
      peerNet: [],
      lan: false,
      ready: false,
      messages: [],
      lastMsgId: 0,
      seenIds: new Set(),
      seenMids: new Set(),
      transfers: new Map(),
    };
    store.sessions.set(session.id, session);
    session.rtc = new SessionRTC({
      sessionId: session.id,
      ws,
      onState: () => {},
      onFrame: (obj, buf) => onRtcFrame(session, obj, buf),
      onLan: (info) => onLanConfirmed(session, info),
    });
    const [offer, net] = await Promise.all([session.rtc.createOffer(), detectNetworkInfo()]);
    session.net = net || [];
    ws.send({ type: 'sessionRequest', sessionId: session.id, target: u.key, offer, net: session.net });
    pushMessage(session, { mine: true, sender: '我', type: 'system', content: '已发送会话请求，等待对方接受…' });
    showSession(session.id);
  }

  function declineRequest(r) {
    ws.send({ type: 'sessionDecline', sessionId: r.sessionId });
    store.requests = store.requests.filter((x) => x.sessionId !== r.sessionId);
    renderRequests();
  }

  function onRtcFrame(session, obj, buf) {
    if (obj && obj.type === 'text') {
      pushMessage(session, { mine: false, sender: session.peer.name, type: 'text', content: obj.content, ts: new Date().toISOString(), clientId: obj.mid });
      return;
    }
    if (!buf) return;
    const header = parseArrayBufferHeader(buf);
    if (header.type === 'ack') {
      const t = session.transfers.get(header.transferId);
      if (t) t.onAck();
      return;
    }
    recvChunk(session, header, new Uint8Array(buf.slice(4 + header.headerLen)));
  }

  function parseArrayBufferHeader(buf) {
    const view = new DataView(buf);
    const len = view.getUint32(0);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len)));
    return { ...header, headerLen: len };
  }

  function sendText(text) {
    const s = activeSession();
    if (!s) return;
    if (!s.ready) return toast('通道建立中，请稍候再发送');
    const ts = new Date().toISOString();
    const mid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (s.rtc?.up) {
      s.rtc.sendText(text, mid);
      ws.send({ type: 'textPersist', sessionId: s.id, content: text, clientId: mid }); // 落库供对方补拉，不转发
    } else {
      ws.send({ type: 'text', sessionId: s.id, content: text, clientId: mid });
    }
    pushMessage(s, { mine: true, sender: '我', type: 'text', content: text, ts, clientId: mid });
  }

  async function sendFiles(fileList) {
    const s = activeSession();
    if (!s) return;
    if (!s.ready) return toast('通道建立中，请稍候再发送');
    for (const file of fileList) {
      if (file.size <= STAGING_LIMIT) {
        await stageFile(s, file);
      } else {
        startBigTransfer(s, file);
      }
    }
  }

  async function stageFile(session, file) {
    const wrap = el('div', { class: 'progress' }, [el('div')]);
    const chip = el('div', { class: 'file-chip' }, [
      el('span', { text: '📄' }),
      el('span', { class: 'fname', text: file.name }),
      wrap,
    ]);
    const bubble = el('div', { class: 'msg mine' }, [chip]);
    chat.body.append(bubble);
    chat.scroll();
    try {
      const d = await uploadWithProgress(
        `/api/staging/upload?session=${encodeURIComponent(session.id)}`,
        file,
        {
          headers: {
            'x-file-name': encodeURIComponent(file.name),
            'x-file-mime': encodeURIComponent(file.type || 'application/octet-stream'),
          },
          onProgress: (r) => { wrap.firstChild.style.width = `${Math.round(r * 100)}%`; },
        }
      );
      bubble.remove();
      pushMessage(session, { mine: true, sender: '我', type: msgType(d.file.kind), content: d.file.filename, file: d.file, messageId: d.message.id, ts: d.message?.created_at });
    } catch (e) {
      bubble.remove();
      toast(e.message, 'error');
    }
  }

  async function startBigTransfer(session, file) {
    const t = new BigTransfer({ session, ws, rtc: session.rtc });
    session.transfers.set(t.transferId, t);
    chat.addTransfer(t.transferId, { file, mine: true });
    t.onProgress = (r) => chat.setTransferProgress(t.transferId, r);
    t.onDone = () => chat.setTransferProgress(t.transferId, 1, `${file.name} · 已发送`);
    await t.start(file);
  }

  // ---- WS 事件 ----
  const offs = [];
  offs.push(ws.on('onlineList', (m) => {
    store.onlineDevices = m.devices || [];
    renderUsers();
  }));
  offs.push(ws.on('incomingRequest', (m) => {
    renderRequests();
  }));
  offs.push(ws.on('requestDeclined', (m) => {
    const s = store.sessions.get(m.sessionId);
    if (s) {
      pushMessage(s, { mine: true, type: 'system', content: '对方拒绝了会话请求' });
      s.ended = true;
      s.active = false;
      if (store.activeSessionId === m.sessionId) exitSessionView();
    }
  }));
  offs.push(ws.on('sessionAccepted', async (m) => {
    const s = store.sessions.get(m.sessionId);
    if (!s) return;
    s.active = true;
    s.peerNet = m.net || [];
    s.lan = hasMatchingSubnet(s.net || [], s.peerNet);
    if (s.rtc) {
      s.rtc.lan = s.lan;
      s.rtc.peerSubnets = s.peerNet.map((x) => x.subnet).filter(Boolean);
    }
    showSession(m.sessionId);
    if (m.answer) {
      try { await s.rtc.pc.setRemoteDescription(m.answer); } catch (e) { console.error(e); }
    }
    if (s.lan) {
      pushMessage(s, { mine: true, type: 'system', content: '检测到同一局域网，已优先使用局域网地址直连' });
    }
    pushMessage(s, { mine: true, type: 'system', content: '对方已接受，正在尝试建立 P2P 隧道…' });
  }));
  offs.push(ws.on('sessionStart', (m) => {
    const s = store.sessions.get(m.sessionId);
    if (!s) return;
    s.active = true;
    pushMessage(s, { mine: true, type: 'system', content: '会话已建立' });
    if (store.activeSessionId === m.sessionId) {
      const mode = s.relay ? '服务器中转' : 'P2P 直连（IPv6 优先）';
      chat.setSub(s.lan ? `同一局域网 · ${mode}` : mode);
    }
  }));
  offs.push(ws.on('sessionMode', (m) => {
    const s = store.sessions.get(m.sessionId);
    if (!s) return;
    s.relay = m.relay;
    if (!s.ready) {
      s.ready = true;
      if (store.activeSessionId === m.sessionId) {
        chat.setInputEnabled(true);
        chat.addSystem(m.relay ? '通道已就绪（服务器中转）' : '通道已就绪，可以开始传输');
      }
    }
    if (store.activeSessionId === m.sessionId) {
      const mode = m.relay ? '服务器中转（无法建立 P2P）' : 'P2P 直连（IPv6 优先）';
      chat.setSub(s.lan ? `同一局域网 · ${mode}` : mode);
      if (m.relay) chat.addSystem('无法建立 P2P 隧道，已切换为服务器中转（文件不落盘）');
    }
  }));
  offs.push(ws.on('signal', async (m) => {
    const s = store.sessions.get(m.sessionId);
    if (s?.rtc) await s.rtc.onSignal(m.payload);
  }));
  offs.push(ws.on('text', (m) => {
    const s = store.sessions.get(m.sessionId);
    if (!s) return;
    if (m.message.sender_id === myUserId()) return;
    pushMessage(s, { mine: false, sender: s.peer.name, type: 'text', content: m.message.content, ts: m.message.created_at, messageId: m.message.id, clientId: m.message.client_id });
  }));
  offs.push(ws.on('stagedFile', (m) => {
    const s = store.sessions.get(m.sessionId);
    if (!s || m.file.ownerId === myUserId()) return;
    pushMessage(s, { mine: false, sender: s.peer.name, type: msgType(m.file.kind), content: m.file.filename, file: m.file, messageId: m.message?.id, ts: m.message?.created_at });
  }));
  offs.push(ws.on('fileOffer', (m) => {
    const s = store.sessions.get(m.sessionId);
    if (!s) return;
    promptAcceptFile(s, m);
  }));
  offs.push(ws.on('fileAccepted', (m) => {
    const s = store.sessions.get(m.sessionId);
    const t = s?.transfers.get(m.transferId);
    if (!t) return;
    t.started = true;
    chat.setTransferProgress(m.transferId, 0, `${t.file.name} · 对方已接收，开始传输`);
    t.pump();
  }));
  offs.push(ws.on('fileDeclined', (m) => {
    const s = store.sessions.get(m.sessionId);
    if (!s) return;
    chat.removeTransfer(m.transferId);
    pushMessage(s, { mine: true, type: 'system', content: '对方拒绝了文件' });
  }));
  offs.push(ws.on('fileDone', (m) => {
    const s = store.sessions.get(m.sessionId);
    const t = s?.transfers.get(m.transferId);
    if (t) {
      const tb = chat.fileTransfers.get(m.transferId);
      tb?.cancelBtn?.remove();
      chat.setTransferProgress(m.transferId, 1, `${t.file.name} · 已发送`);
    }
  }));
  offs.push(ws.on('fileCanceled', (m) => {
    const s = store.sessions.get(m.sessionId);
    if (s) {
      const t = s.transfers.get(m.transferId);
      if (t) {
        if (t.cancel) t.cancel();
        else if (t.writable) {
          try { t.writable.close(); } catch { /* ignore */ }
        }
        s.transfers.delete(m.transferId);
        recvState.delete(`${m.sessionId}:${m.transferId}`);
        chat.setTransferCanceled(m.transferId, '对方已取消传输');
      }
    }
    const pm = pendingFileOffers.get(m.transferId);
    if (pm) {
      pm.close();
      pendingFileOffers.delete(m.transferId);
      toast('对方已取消文件传输');
    }
  }));
  offs.push(ws.on('ack', (m) => {
    const s = store.sessions.get(m.sessionId);
    const t = s?.transfers.get(m.transferId);
    if (t) t.onAck();
  }));
  offs.push(ws.on('peerOffline', (m) => {
    const s = store.sessions.get(m.sessionId);
    if (!s) return;
    pushMessage(s, { mine: true, type: 'system', content: '对方已下线，会话结束' });
    s.active = false;
    s.ended = true;
    try { s.rtc?.close(); } catch { /* ignore */ }
    for (const tid of s.transfers.keys()) chat.removeTransfer(tid);
    if (store.activeSessionId === m.sessionId) {
      toast('对方已下线，会话结束');
      exitSessionView();
    }
  }));
  offs.push(ws.on('sessionEnded', (m) => {
    const s = store.sessions.get(m.sessionId);
    store.requests = store.requests.filter((x) => x.sessionId !== m.sessionId);
    renderRequests(); // 撤掉接收方的请求提醒（含取消请求场景）
    if (!s || s.ended) return;
    s.ended = true;
    s.active = false;
    try { s.rtc?.close(); } catch { /* ignore */ }
    if (store.activeSessionId === m.sessionId) {
      toast('对方已结束会话');
      exitSessionView();
    }
  }));

  // 接收大文件
  const recvState = new Map(); // sessionId:transferId -> {writable, blobParts, size, count, expectedName}
  const pendingFileOffers = new Map(); // transferId -> modal close
  offs.push(ws.on('fileChunk', (m) => {
    const s = store.sessions.get(m.sessionId);
    if (!s) return;
    recvChunk(s, m, m.payload);
  }));
  ws.on('fileChunk', (m) => {}); // noop guard

  async function promptAcceptFile(session, offer) {
    if (pendingFileOffers.has(offer.transferId)) return;
    let m = null;
    const ok = await new Promise((resolve) => {
      m = modal({
        title: '接收文件',
        body: `收到文件：${offer.name}（${fmtBytes(offer.size)}），点击接收后开始传输，接收完成后自动下载。`,
        actions: [
          { label: '拒绝', class: 'secondary', onClick: () => { pendingFileOffers.delete(offer.transferId); resolve(false); m.close(); } },
          { label: '接收', class: 'ok', onClick: () => { pendingFileOffers.delete(offer.transferId); resolve(true); m.close(); } },
        ],
      });
      pendingFileOffers.set(offer.transferId, m);
    });
    if (!ok) {
      ws.send({ type: 'fileDecline', sessionId: session.id, transferId: offer.transferId });
      return;
    }
    // 直接触发下载（安卓等不支持选择保存位置的浏览器也适用）
    const state = {
      writable: null,
      parts: [],
      size: offer.size,
      count: 0,
      name: offer.name,
      canceled: false,
      chunks: new Map(),
      nextSeq: 0,
      ackSeq: 0,
    };
    session.transfers.set(offer.transferId, state);
    chat.addTransfer(offer.transferId, { file: { name: offer.name, size: offer.size }, mine: false });
    ws.send({ type: 'fileAccept', sessionId: session.id, transferId: offer.transferId });
    recvState.set(`${session.id}:${offer.transferId}`, state);
  }

  function recvChunk(session, m, payload) {
    const state = session.transfers.get(m.transferId);
    if (!state || !state.size) return;
    if (state.canceled) return;
    if (state.chunks.has(m.seq)) return; // 去重
    state.chunks.set(m.seq, payload);
    // 按序号顺序组装，避免 P2P/中转切换导致乱序损坏
    while (state.chunks.has(state.nextSeq)) {
      const p = state.chunks.get(state.nextSeq);
      state.chunks.delete(state.nextSeq);
      state.nextSeq++;
      state.count = state.nextSeq;
      if (state.writable) {
        state.writable.write(p).catch(() => {});
      } else {
        state.parts.push(p);
      }
    }
    const received = Math.min(state.nextSeq * CHUNK, state.size);
    chat.setTransferProgress(m.transferId, received / state.size);
    if (state.nextSeq - state.ackSeq >= ACK_EVERY) {
      state.ackSeq = state.nextSeq;
      const ack = { type: 'ack', sessionId: session.id, transferId: m.transferId, seq: m.seq };
      if (session.rtc?.up && session.rtc.dc?.readyState === 'open') {
        session.rtc.sendFrame(ack, null);
      } else {
        ws.send(ack);
      }
    }
    if (m.done && received >= state.size) {
      finishReceive(session, m.transferId, state);
    }
  }

  async function finishReceive(session, transferId, state) {
    if (state.canceled) return;
    const blob = new Blob(state.parts);
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: state.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    recvState.delete(`${session.id}:${transferId}`);
    session.transfers.delete(transferId);
    chat.removeTransfer(transferId);
    pushMessage(session, { mine: false, sender: session.peer.name, type: 'system', content: `已接收文件：${state.name}` });
    ws.send({ type: 'fileDone', sessionId: session.id, transferId });
  }

  renderLayout();
  renderUsers();
  const onResume = () => resumeSessionSync();
  window.addEventListener('wd-resume', onResume);
  const onResize = () => renderRequests();
  window.addEventListener('resize', onResize);
  return () => {
    offs.forEach((f) => f());
    window.removeEventListener('wd-resume', onResume);
    window.removeEventListener('resize', onResize);
  };
}

function msgType(kind) {
  return kind === 'voice' ? 'voice' : kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'file';
}

export function viewLogin(container) {
  container.innerHTML = '';
  const loginForm = el('form', { class: 'panel container', style: 'max-width:420px;margin:40px auto' }, [
    el('h2', { text: '登录' }),
    el('div', { class: 'form-group' }, [el('label', { text: '用户名' }), el('input', { name: 'username', required: true })]),
    el('div', { class: 'form-group' }, [el('label', { text: '密码' }), el('input', { name: 'password', type: 'password', required: true })]),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn', type: 'submit', text: '登录' }),
      el('a', { href: '#/register', text: '注册账号' }),
    ]),
    el('div', { id: 'login-err', class: 'muted', style: 'margin-top:10px' }),
  ]);
  container.append(loginForm);
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(loginForm);
    try {
      const d = await api('/api/auth/login', {
        method: 'POST',
        body: {
          username: fd.get('username'),
          password: fd.get('password'),
          deviceId: localStorage.getItem('wd_device_id') || '',
        },
      });
      const { saveAuth } = await import('./state.js');
      saveAuth(d.token, d.user);
      const { ws } = await import('./state.js');
      ws?.setToken(d.token);
      if (d.user.mustChange) {
        showAdminChange(container, d.token);
      } else {
        location.hash = d.user.role === 'admin' ? '#/admin' : '#/';
        window.dispatchEvent(new Event('wd-refresh'));
      }
    } catch (err) {
      $('#login-err').textContent = err.message;
    }
  });
}

async function showAdminChange(container, token) {
  container.innerHTML = '';
  const form = el('form', { class: 'panel container', style: 'max-width:420px;margin:40px auto' }, [
    el('h2', { text: '首次登录，请修改管理员用户名和密码' }),
    el('div', { class: 'form-group' }, [el('label', { text: '新用户名' }), el('input', { name: 'username', required: true })]),
    el('div', { class: 'form-group' }, [el('label', { text: '新密码' }), el('input', { name: 'password', type: 'password', required: true })]),
    el('button', { class: 'btn', type: 'submit', text: '保存并进入管理台' }),
    el('div', { id: 'chg-err', class: 'muted', style: 'margin-top:10px' }),
  ]);
  container.append(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: { newUsername: fd.get('username'), newPassword: fd.get('password') },
        headers: { Authorization: `Bearer ${token}` },
      });
      const { saveAuth, store, ws } = await import('./state.js');
      saveAuth(token, { ...store.user, username: fd.get('username'), mustChange: false });
      ws?.setToken(token);
      location.hash = '#/admin';
      window.dispatchEvent(new Event('wd-refresh'));
    } catch (err) {
      $('#chg-err').textContent = err.message;
    }
  });
}

export function viewRegister(container) {
  container.innerHTML = '';
  const form = el('form', { class: 'panel container', style: 'max-width:420px;margin:40px auto' }, [
    el('h2', { text: '注册（需管理员审核）' }),
    el('div', { class: 'form-group' }, [el('label', { text: '用户名' }), el('input', { name: 'username', required: true })]),
    el('div', { class: 'form-group' }, [el('label', { text: '密码' }), el('input', { name: 'password', type: 'password', required: true })]),
    el('div', { class: 'form-group' }, [el('label', { text: '昵称（可选，不填则显示用户名）' }), el('input', { name: 'nickname' })]),
    el('div', { class: 'form-group' }, [el('label', { text: '邮箱' }), el('input', { name: 'email', type: 'email' })]),
    el('div', { class: 'form-group' }, [el('label', { text: 'QQ 号' }), el('input', { name: 'qq' })]),
    el('div', { class: 'muted', style: 'margin-bottom:12px' }, '邮箱或 QQ 号至少填写一种'),
    el('button', { class: 'btn', type: 'submit', text: '提交注册' }),
    el('div', { id: 'reg-msg', class: 'muted', style: 'margin-top:10px' }),
  ]);
  container.append(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      const d = await api('/api/auth/register', {
        method: 'POST',
        body: {
          username: fd.get('username'),
          password: fd.get('password'),
          nickname: fd.get('nickname'),
          email: fd.get('email'),
          qq: fd.get('qq'),
        },
      });
      $('#reg-msg').textContent = d.message || '已提交';
    } catch (err) {
      $('#reg-msg').textContent = err.message;
    }
  });
}

export function viewRooms(container) {
  container.innerHTML = '';
  const root = el('div', { class: 'container' });
  const listWrap = el('div');
  const joinInput = el('input', { type: 'text', placeholder: '输入房间号加入' });
  const btnJoin = el('button', { class: 'btn', text: '加入' });
  const btnCreate = el('button', { class: 'btn ok', text: '创建房间' });
  const joinRow = el('div', { class: 'join-row' }, [joinInput, btnJoin]);
  root.append(
    el('div', { class: 'row room-head-row', style: 'margin-bottom:14px' }, [
      el('h2', { class: 'grow', text: '房间' }),
      joinRow,
      btnCreate,
    ]),
    listWrap
  );
  container.append(root);

  btnJoin.addEventListener('click', () => {
    const n = joinInput.value.trim();
    if (n) location.hash = `#/room/${encodeURIComponent(n)}`;
  });
  btnCreate.addEventListener('click', () => checkAndCreate());

  async function checkAndCreate() {
    const user = store.user;
    if (!user || user.role !== 'registered') {
      return toast('临时用户无权限创建房间，请注册账号', 'error', 4000);
    }
    try {
      const d = await api('/api/rooms/mine');
      const active = d.rooms.filter((r) => r.status === 'active' || r.status === 'pending').length;
      const level = Math.max(0, Math.min(6, Number(user.level) || 0));
      const quota = [1, 2, 3, 4, 6, 8, 10][level];
      if (active >= quota) {
        return toast(`当前权限 V${level} 只能创建 ${quota} 个房间，如有需求请联系管理员修改权限`, 'error', 5000);
      }
    } catch {
      // 网络异常不阻塞，交由服务端再次校验
    }
    showCreateRoom();
  }

  async function load() {
    let mine = { rooms: [] };
    let history = { rooms: [] };
    try {
      [mine, history] = await Promise.all([
        api('/api/rooms/mine'),
        api('/api/rooms/history'),
      ]);
    } catch (e) {
      if (e.status !== 401) toast(e.message, 'error'); // 临时用户首次访问静默
    }
    listWrap.innerHTML = '';
    const renderCards = (rooms, canDestroy) => {
      for (const room of rooms) {
        if (room.status === 'destroyed') continue; // 已销毁的房间直接消失，不展示状态
        const active = room.status === 'active';
        const titleEl = active
          ? el('a', { class: 'grow', href: `#/room/${encodeURIComponent(room.number)}`, text: `${room.number}${room.title ? ' · ' + room.title : ''}${room.hasPassword ? ' 🔒' : ''}` })
          : el('span', { class: 'grow', text: `${room.number}${room.title ? ' · ' + room.title : ''}${room.hasPassword ? ' 🔒' : ''}` });
        const card = el('div', { class: 'card row' }, [
          titleEl,
          el('span', { class: `badge ${active ? 'ok' : room.status === 'pending' ? 'warn' : 'muted'}`, text: active ? '可用' : room.status === 'pending' ? '待审批' : '已销毁' }),
          el('span', { class: 'muted', text: room.destroyAt ? `销毁时间：${fmtTime(room.destroyAt)}` : '永久保留' }),
          ...(canDestroy && active
            ? [el('button', {
                class: 'btn danger small',
                text: '销毁',
                onClick: async () => {
                  if (!(await confirmDialog('销毁房间', `确定销毁房间 ${room.number} 吗？房间内所有文件将被删除。`, '销毁', true))) return;
                  try {
                    await api(`/api/rooms/${encodeURIComponent(room.number)}`, { method: 'DELETE' });
                    load();
                  } catch (e) { toast(e.message, 'error'); }
                },
              })]
            : []),
        ]);
        listWrap.append(card);
      }
    };
    if (mine.rooms.length) {
      listWrap.append(el('div', { class: 'group-title', text: '我的房间' }));
      renderCards(mine.rooms, true);
    }
    const historyRooms = history.rooms.filter((r) => !mine.rooms.some((m) => m.id === r.id));
    if (historyRooms.length) {
      listWrap.append(el('div', { class: 'group-title', text: '历史房间' }));
      renderCards(historyRooms, false);
    }
    if (!mine.rooms.length && !historyRooms.length) {
      listWrap.append(el('div', { class: 'empty', text: '还没有加入过房间，点击“开启房间”创建一个' }));
    }
  }

  function showCreateRoom() {
    const modeRandom = el('input', { type: 'radio', name: 'mode', value: 'random', checked: true });
    const modeCustom = el('input', { type: 'radio', name: 'mode', value: 'custom' });
    const customInput = el('input', { type: 'text', placeholder: '6-12 位数字/中文/大小写英文' });
    const customHint = el('div', { class: 'muted hidden', text: '自定义房间号需管理员审批，审批通过前房间不可加入' });
    const destroySelect = el('select', {}, [
      el('option', { value: 'permanent', text: '永久保留' }),
      el('option', { value: 'd1', text: '1 天后销毁' }),
      el('option', { value: 'd7', text: '7 天后销毁' }),
      el('option', { value: 'd30', text: '30 天后销毁' }),
    ]);
    const titleInput = el('input', { type: 'text', placeholder: '房间标题（可选）' });
    const passwordInput = el('input', { type: 'password', placeholder: '留空表示无密码' });
    const body = el('div', {}, [
      el('div', { class: 'form-group' }, [el('label', { text: '房间名' }), titleInput]),
      el('div', { class: 'form-group' }, [el('label', { text: '房间密码（可选，默认无）' }), passwordInput]),
      el('div', { class: 'form-group' }, [
        el('label', { text: '房间号方式' }),
        el('div', {}, [el('label', {}, [modeRandom, ' 随机分配'])]),
        el('div', {}, [el('label', {}, [modeCustom, ' 自定义'])]),
        customInput,
        customHint,
      ]),
      el('div', { class: 'form-group' }, [el('label', { text: '销毁时间' }), destroySelect]),
    ]);
    const m = modal({
      title: '创建房间',
      body,
      actions: [
        { label: '取消', class: 'secondary', onClick: () => m.close() },
        {
          label: '创建',
          onClick: async () => {
            try {
              const mode = modeRandom.checked ? 'random' : 'custom';
              const d = await api('/api/rooms', {
                method: 'POST',
                body: {
                  mode,
                  customNumber: mode === 'custom' ? customInput.value.trim() : undefined,
                  title: titleInput.value,
                  destroyAt: destroySelect.value,
                  password: passwordInput.value,
                },
              });
              m.close();
              if (d.pending) {
                toast('自定义房间号已提交审批，通过后即可加入', 'info', 6000);
              } else {
                location.hash = `#/room/${encodeURIComponent(d.room.number)}`;
              }
              load();
            } catch (e) { toast(e.message, 'error'); }
          },
        },
      ],
    });
    const showHint = () => customHint.classList.toggle('hidden', !modeCustom.checked);
    modeRandom.addEventListener('change', showHint);
    modeCustom.addEventListener('change', showHint);
  }

  load().catch((e) => toast(e.message, 'error'));
}

export function viewRoom(container, number) {
  container.innerHTML = '';
  const root = el('div', { class: 'container' });
  const head = el('div', { class: 'row room-head', style: 'margin-bottom:12px' });
  const membersTxt = el('span', { class: 'muted' });
  const chatWrap = el('div', { class: 'room-chat', style: 'height:60vh' });
  const delFileCb = el('input', { type: 'checkbox' });
  const selectCount = el('span', { class: 'muted', text: '已选 0 条' });
  const selectBar = el('div', { class: 'room-select-bar hidden' }, [
    selectCount,
    el('label', { class: 'small' }, [delFileCb, ' 同时删除对应文件']),
    el('button', { class: 'btn danger small', text: '删除选中', onClick: deleteSelected }),
    el('button', { class: 'btn secondary small', text: '取消', onClick: exitSelect }),
  ]);
  root.append(head, chatWrap, selectBar);
  container.append(root);

  const chat = new ChatView({
    title: `房间 ${number}`,
    onText: (t) => sendText(t),
    onFiles: (files) => uploadFiles(files),
    // 聊天框录音默认归档到房间文件的 m4a 文件夹，便于房主统一清理
    onVoice: (blob) => uploadFiles([blob], 'm4a'),
    onFilePick: (active) => ws.setFilePick(active),
  });
  chat.onSelectChange = updateSelectBar;
  chatWrap.append(chat.root);
  // 向上滚动到顶时自动加载更早的消息
  chat.body.addEventListener('scroll', () => {
    if (chat.body.scrollTop <= 4) loadOlderMessages();
  });

  let room = null;
  let roomPassword = '';
  const seen = new Set();
  let currentMembers = [];
  const MSG_PAGE = 20;
  let loadedMaxId = null;
  let loadedCount = 0;
  let oldestLoadedId = null;
  let hasMore = false;
  let loadingOlder = false;
  let selectBtn = null;
  let memberBtn = null;

  async function init() {
    try {
      const info = await api(`/api/rooms/${encodeURIComponent(number)}`);
      if (info.room.hasPassword && !roomPassword) {
        const pw = await promptRoomPassword();
        if (pw === null) {
          location.hash = '#/rooms';
          return;
        }
        roomPassword = pw;
      }
      let d;
      try {
        d = await api(`/api/rooms/${encodeURIComponent(number)}/join`, { method: 'POST', body: { password: roomPassword } });
      } catch (e) {
        if (!e.message.includes('密码')) throw e;
        const pw = await promptRoomPassword();
        if (pw === null) { location.hash = '#/rooms'; return; }
        roomPassword = pw;
        d = await api(`/api/rooms/${encodeURIComponent(number)}/join`, { method: 'POST', body: { password: roomPassword } });
      }
      room = d.room;
      ws.send({ type: 'roomJoin', number });
      head.innerHTML = '';
      // 文件 / 选择按钮放到聊天标题行（“房间 xxxxxx”）右侧
      chat.head.append(el('button', {
        class: 'btn secondary small',
        text: '文件',
        onClick: () => showFiles(),
      }));
      const headBtns = [membersTxt];
      if (room.ownerId === myUserId()) {
        membersTxt.classList.add('hidden');
        selectBtn = el('button', {
          class: 'btn secondary small',
          text: '选择',
          onClick: toggleSelect,
        });
        chat.head.append(selectBtn);
        memberBtn = el('button', {
          class: 'btn secondary small',
          text: '在线0人',
          onClick: () => showMembers(),
        });
        headBtns.push(memberBtn);
        headBtns.push(el('button', {
          class: 'btn secondary small',
          text: '设置',
          onClick: () => showRoomSettings(),
        }));
      }
      headBtns.push(el('button', {
        class: 'btn danger small',
        text: '退出',
        onClick: () => {
          ws.send({ type: 'roomLeave', number });
          api(`/api/rooms/${encodeURIComponent(number)}/leave`, { method: 'POST' }).catch(() => {});
          location.hash = '#/rooms';
        },
      }));
      head.append(
        el('h2', { class: 'grow room-title' }, [el('span', { class: 'room-title-inner', text: room.title || '未命名房间' })]),
        ...headBtns
      );
      makeDragScroll(head.querySelector('.room-title'));
      renderMembers(d.members);
      // 先填充文件缓存，历史文件/语音消息才能正常显示下载与播放
      const files = await api(`/api/rooms/${encodeURIComponent(number)}/files`);
      for (const f of files.files) fileCache.set(f.id, f);
      await loadInitialMessages();
    } catch (e) {
      // 进房失败：显示明确提示而不是空聊天界面
      container.innerHTML = '';
      container.append(
        el('div', { class: 'container', style: 'max-width:440px;margin:80px auto;text-align:center' }, [
          el('div', { style: 'font-size:44px;margin-bottom:12px', text: '🚫' }),
          el('h2', { text: '无法进入房间' }),
          el('p', { class: 'muted', style: 'margin:10px 0 18px', text: e.message }),
          el('button', {
            class: 'btn',
            text: '返回房间列表',
            onClick: () => {
              location.hash = '#/rooms';
            },
          }),
        ])
      );
      toast(e.message, 'error');
    }
  }

  function promptRoomPassword() {
    return new Promise((resolve) => {
      const input = el('input', { type: 'password', placeholder: '请输入房间密码' });
      let m = null;
      m = modal({
        title: '房间需要密码',
        body: input,
        actions: [
          { label: '取消', class: 'secondary', onClick: () => { resolve(null); m.close(); } },
          { label: '加入', class: 'ok', onClick: () => { resolve(input.value); m.close(); } },
        ],
      });
    });
  }

  function showRoomSettings() {
    const titleInput = el('input', { type: 'text', value: room.title || '' });
    const keepPw = el('input', { type: 'checkbox', checked: true });
    const pwInput = el('input', { type: 'password', placeholder: '新密码' });
    const maxRetSel = el('select', {}, [
      el('option', { value: '', text: '永久（不限制）' }),
      el('option', { value: '1', text: '1 天' }),
      el('option', { value: '7', text: '7 天' }),
      el('option', { value: '30', text: '30 天' }),
    ]);
    maxRetSel.value = room.maxRetentionDays ? String(room.maxRetentionDays) : '';
    const maxSizeInput = el('input', {
      type: 'number',
      value: Math.round((room.maxFileSize || 10 * 1024 ** 3) / 1024 ** 3),
      min: 1,
      max: 10,
      step: 1,
    });
    const capacityInput = el('input', {
      type: 'number',
      value: room.roomCapacityBytes ? Math.round(room.roomCapacityBytes / 1024 ** 3) : '',
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
    uploadPermSel.value = room.uploadPermission || 'all';
    downloadPermSel.value = room.downloadPermission || 'all';
    const m = modal({
      title: '房间设置',
      body: el('div', {}, [
        el('div', { class: 'form-group' }, [el('label', { text: '房间名（房间号不可修改）' }), titleInput]),
        el('div', { class: 'form-group' }, [
          el('label', {}, [keepPw, ' 保持当前密码不变']),
          pwInput,
          el('div', { class: 'muted', text: '取消勾选后：留空 = 清除密码，填写 = 设置新密码' }),
        ]),
        el('div', { class: 'form-group' }, [
          el('label', { text: '其他用户上传文件最长保留时间' }),
          maxRetSel,
          el('div', { class: 'muted', text: '仅限制其他成员上传的文件；房主自己上传不受限。选择"永久"则不限制' }),
        ]),
        el('div', { class: 'form-group' }, [
          el('label', { text: '单文件最大上传大小（GB，1-10）' }),
          maxSizeInput,
          el('div', { class: 'muted', text: '单个文件最大可填 10G' }),
        ]),
        el('div', { class: 'form-group' }, [
          el('label', { text: '房间文件总容量（GB，可留空）' }),
          capacityInput,
          el('div', { class: 'muted', text: '最大可填与该用户持久空间一致；留空表示不额外限制' }),
        ]),
        el('div', { class: 'form-group' }, [el('label', { text: '允许其他人上传' }), uploadPermSel]),
        el('div', { class: 'form-group' }, [el('label', { text: '允许其他人下载' }), downloadPermSel]),
        el('div', { class: 'form-group' }, [
          el('label', { text: '消息管理' }),
          el('div', { class: 'row' }, [
            el('button', { class: 'btn secondary small', text: '选择消息', onClick: () => { m.close(); toggleSelect(); } }),
            el('button', { class: 'btn secondary small', text: '消息管理', onClick: () => { m.close(); openMessageManager(); } }),
          ]),
        ]),
      ]),
      actions: [
        { label: '取消', class: 'secondary', onClick: () => m.close() },
        {
          label: '保存',
          class: 'ok',
          onClick: async () => {
            try {
              const d = await api(`/api/rooms/${encodeURIComponent(number)}`, {
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
              room = d.room;
              head.querySelector('h2').textContent = room.title || '未命名房间';
              m.close();
              toast('房间设置已保存');
            } catch (e) { toast(e.message, 'error'); }
          },
        },
      ],
    });
  }

  function showMembers() {
    const body = el('div');
    const render = async () => {
      body.innerHTML = '';
      const d = await api(`/api/rooms/${encodeURIComponent(number)}/members`);
      const bl = await api(`/api/rooms/${encodeURIComponent(number)}/blacklist`);
      body.append(el('div', { class: 'group-title', text: `成员（${d.members.length}）` }));
      if (!d.members.length) body.append(el('div', { class: 'muted', text: '暂无成员' }));
      for (const m of d.members) {
        const isOwner = m.id === room.ownerId;
        body.append(el('div', { class: 'request-item' }, [
          el('span', { class: 'grow', text: m.displayName }),
          ...(isOwner
            ? [el('span', { class: 'badge ok', text: '房主' })]
            : [
                el('button', {
                  class: 'btn secondary small',
                  text: '踢出',
                  onClick: async () => {
                    try {
                      await api(`/api/rooms/${encodeURIComponent(number)}/members/${m.id}/kick`, { method: 'POST', body: {} });
                      render();
                    } catch (e) { toast(e.message, 'error'); }
                  },
                }),
                el('button', {
                  class: 'btn danger small',
                  text: '拉黑',
                  onClick: async () => {
                    try {
                      await api(`/api/rooms/${encodeURIComponent(number)}/members/${m.id}/blacklist`, { method: 'POST', body: {} });
                      render();
                    } catch (e) { toast(e.message, 'error'); }
                  },
                }),
              ]),
        ]));
      }
      body.append(el('div', { class: 'group-title', text: '黑名单' }));
      if (!bl.users.length) body.append(el('div', { class: 'muted', text: '暂无' }));
      for (const u of bl.users) {
        body.append(el('div', { class: 'request-item' }, [
          el('span', { class: 'grow', text: u.name }),
          el('button', {
            class: 'btn secondary small',
            text: '解除拉黑',
            onClick: async () => {
              try {
                await api(`/api/rooms/${encodeURIComponent(number)}/blacklist/${u.id}/unban`, { method: 'POST', body: {} });
                render();
              } catch (e) { toast(e.message, 'error'); }
            },
          }),
        ]));
      }
    };
    const m = modal({
      title: '房间成员',
      body,
      actions: [{ label: '关闭', class: 'secondary', onClick: () => m.close() }],
    });
    render().catch((e) => toast(e.message, 'error'));
  }

  function renderMembers(list) {
    currentMembers = list || [];
    membersTxt.textContent = `${list.length} 人在线`;
    if (memberBtn) memberBtn.textContent = `在线${list.length}人`;
  }

  // ---- 房主消息管理：多选删除气泡 ----
  function toggleSelect() {
    const on = !chat.selectMode;
    chat.setSelectMode(on);
    selectBar.classList.toggle('hidden', !on);
    if (selectBtn) selectBtn.classList.toggle('active', on);
  }

  function exitSelect() {
    chat.setSelectMode(false);
    selectBar.classList.add('hidden');
  }

  function updateSelectBar() {
    selectCount.textContent = `已选 ${chat.selected.size} 条`;
  }

  async function deleteSelected() {
    const ids = [...chat.selected];
    if (!ids.length) return toast('请先选择消息', 'error');
    const delFile = delFileCb.checked;
    if (!(await confirmDialog('删除消息', `确定删除选中的 ${ids.length} 条消息吗？${delFile ? '对应文件也会被删除。' : ''}`, '删除', true))) return;
    try {
      await api(`/api/rooms/${encodeURIComponent(number)}/messages/delete`, { method: 'POST', body: { messageIds: ids, deleteFile: delFile } });
      chat.removeMessages(ids);
      exitSelect();
      toast('已删除');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function openMessageManager() {
    const PAGE_SIZE = 10;
    const listWrap = el('div', { class: 'msg-manage-list' });
    const delFileCb2 = el('input', { type: 'checkbox' });
    const statusSel = el('select', {}, [
      ['all', '全部状态'], ['visible', '可见'], ['deleted', '已删除'],
    ].map(([v, t]) => el('option', { value: v, text: t })));
    statusSel.value = 'visible'; // 默认仅看可见的消息
    const typeSel = el('select', {}, [
      ['all', '全部类型'], ['text', '消息'], ['video', '视频'], ['voice', '音频'], ['image', '图片'], ['file', '文件'],
    ].map(([v, t]) => el('option', { value: v, text: t })));
    const qInput = el('input', { type: 'text', placeholder: '搜索消息…' });
    const pageInfo = el('span', { class: 'muted', text: '第 1 / 1 页' });
    const prevBtn = el('button', { class: 'btn secondary small', text: '上一页' });
    const nextBtn = el('button', { class: 'btn secondary small', text: '下一页' });
    let page = 1;
    let total = 0;
    const selected = new Map(); // id -> 0 未删除 / 1 已删除
    let searchTimer = null;
    const load = async (resetPage = false) => {
      if (resetPage) page = 1;
      const qs = `page=${page}&pageSize=${PAGE_SIZE}&status=${statusSel.value}&type=${typeSel.value}&q=${encodeURIComponent(qInput.value.trim())}`;
      const d = await api(`/api/rooms/${encodeURIComponent(number)}/messages/all?${qs}`);
      const msgs = d.messages || [];
      total = d.total || 0;
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      pageInfo.textContent = `第 ${page} / ${pages} 页（共 ${total} 条）`;
      prevBtn.disabled = page <= 1;
      nextBtn.disabled = page >= pages;
      listWrap.innerHTML = '';
      if (!msgs.length) {
        listWrap.append(el('div', { class: 'empty', text: '没有符合条件的消息' }));
        return;
      }
      for (const m of msgs) {
        const isDel = !!m.deleted;
        const cb = el('input', { type: 'checkbox' });
        cb.checked = selected.has(String(m.id));
        cb.addEventListener('change', () => {
          if (cb.checked) selected.set(String(m.id), isDel ? 1 : 0);
          else selected.delete(String(m.id));
        });
        const name = memberDisplay(m.sender_id) || m.sender_name || '用户';
        const text = m.type === 'voice' ? `🎙️ ${m.content || '语音'}`
          : m.type === 'image' ? `🖼️ ${m.content || '图片'}`
            : m.type === 'video' ? `🎬 ${m.content || '视频'}`
              : m.type === 'file' ? `📄 ${m.content || '文件'}`
                : (m.content || '');
        listWrap.append(el('div', { class: `msg-manage-item${isDel ? ' deleted' : ''}` }, [
          el('label', { class: 'row', style: 'gap:8px' }, [
            cb,
            el('span', { class: 'small', text: `${name} · ${fmtTime(m.created_at)}` }),
            isDel
              ? el('span', { class: 'badge muted', text: '已删除' })
              : m.file_status === 'deleted'
                ? el('span', { class: 'badge muted', text: '文件已删除' })
                : el('span', { class: 'badge ok', text: '正常' }),
          ]),
          el('div', { class: 'small', style: 'word-break:break-all;margin-top:2px', text }),
        ]));
      }
    };
    const doAction = async (kind) => {
      const ids = kind === 'restore'
        ? [...selected.keys()].filter((id) => selected.get(id) === 1)
        : [...selected.keys()].filter((id) => selected.get(id) === 0);
      if (!ids.length) return toast(kind === 'restore' ? '请选择已删除的消息' : '请选择未删除的消息', 'error');
      if (kind === 'restore') {
        if (!(await confirmDialog('恢复消息', `确定恢复选中的 ${ids.length} 条消息吗？`, '恢复'))) return;
        try {
          await api(`/api/rooms/${encodeURIComponent(number)}/messages/restore`, { method: 'POST', body: { messageIds: ids } });
          toast('已恢复');
          selected.clear();
          load();
        } catch (e) { toast(e.message, 'error'); }
      } else {
        if (!(await confirmDialog('删除消息', `确定删除选中的 ${ids.length} 条消息吗？${delFileCb2.checked ? '对应文件也会被删除。' : ''}`, '删除', true))) return;
        try {
          await api(`/api/rooms/${encodeURIComponent(number)}/messages/delete`, { method: 'POST', body: { messageIds: ids, deleteFile: delFileCb2.checked } });
          chat.removeMessages(ids);
          toast('已删除');
          selected.clear();
          load();
        } catch (e) { toast(e.message, 'error'); }
      }
    };
    statusSel.addEventListener('change', () => load(true));
    typeSel.addEventListener('change', () => load(true));
    qInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => load(true), 300);
    });
    prevBtn.addEventListener('click', () => { if (page > 1) { page--; load(); } });
    nextBtn.addEventListener('click', () => { if (page * PAGE_SIZE < total) { page++; load(); } });
    const mm = modal({
      title: '消息管理（已删除的消息仅此处可见）',
      className: 'modal-wide',
      body: el('div', {}, [
        el('div', { class: 'rf-toolbar', style: 'margin-bottom:8px' }, [statusSel, typeSel, qInput]),
        el('label', { class: 'small', style: 'margin-bottom:8px;display:block' }, [delFileCb2, ' 删除时同时删除对应文件']),
        listWrap,
        el('div', { class: 'row', style: 'margin-top:8px' }, [pageInfo, el('span', { class: 'grow' }), prevBtn, nextBtn]),
      ]),
      actions: [
        { label: '恢复选中', class: 'ok', onClick: () => doAction('restore') },
        { label: '删除选中', class: 'danger', onClick: () => doAction('delete') },
        { label: '关闭', class: 'secondary', onClick: () => mm.close() },
      ],
    });
    load().catch((e) => toast(e.message, 'error'));
  }

  function appendRoomMessage(m, mine, anchor = null) {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    if (m.type === 'system') {
      const name = memberDisplay(m.sender_id) || m.sender_name;
      chat.addSystem(`${name} ${m.content}`);
      return;
    }
    const sender = mine ? '我' : memberDisplay(m.sender_id) || m.sender_name;
    if (m.file_id) {
      // 由 roomFileReady/文件列表补充 file 信息
      const f = fileById(m.file_id);
      chat.addMessage({
        mine,
        sender,
        type: msgType(f?.kind || (m.type === 'voice' ? 'voice' : m.type)),
        content: m.content,
        file: f,
        messageId: m.id,
        ts: m.created_at,
      }, anchor);
      return;
    }
    chat.addMessage({ mine, sender, type: 'text', content: m.content, messageId: m.id, ts: m.created_at }, anchor);
  }

  async function loadInitialMessages() {
    const d = await api(`/api/rooms/${encodeURIComponent(number)}/messages?limit=${MSG_PAGE}`);
    const msgs = d.messages || [];
    hasMore = !!d.hasMore;
    loadedMaxId = msgs.length ? msgs[msgs.length - 1].id : null;
    oldestLoadedId = msgs.length ? msgs[0].id : null;
    loadedCount = msgs.length;
    for (const m of msgs) appendRoomMessage(m, m.sender_id === myUserId());
    chat.scroll();
    requestAnimationFrame(() => chat.scroll());
    setTimeout(() => chat.scroll(), 300);
    setTimeout(() => chat.scroll(), 900);
  }

  async function loadOlderMessages() {
    if (loadingOlder || !hasMore || oldestLoadedId == null) return;
    loadingOlder = true;
    // 顶部显示加载指示，至少停留 600ms（500ms-1s 区间），防止滑动过快反复触发
    const baseH = chat.body.scrollHeight;
    const baseT = chat.body.scrollTop;
    const spinner = el('div', { class: 'chat-loading' }, [
      el('span', { class: 'spinner' }),
      el('span', { text: '正在加载…' }),
    ]);
    chat.body.prepend(spinner);
    const minWait = new Promise((res) => setTimeout(res, 600));
    try {
      const [d] = await Promise.all([
        api(`/api/rooms/${encodeURIComponent(number)}/messages?limit=${MSG_PAGE}&before=${oldestLoadedId}`),
        minWait,
      ]);
      const msgs = d.messages || [];
      hasMore = !!d.hasMore;
      if (!msgs.length) {
        spinner.remove();
        hasMore = false;
        return;
      }
      oldestLoadedId = msgs[0].id;
      loadedCount += msgs.length;
      spinner.remove();
      const anchor = chat.body.querySelector('.msg');
      for (const m of msgs) appendRoomMessage(m, m.sender_id === myUserId(), anchor);
      chat.body.scrollTop = baseT + (chat.body.scrollHeight - baseH);
    } catch (e) {
      spinner.remove();
      toast(e.message, 'error');
    } finally {
      loadingOlder = false;
    }
  }

  /** 恢复消息后重建当前已加载窗口（保持已加载范围） */
  async function reloadVisibleMessages() {
    const limit = Math.max(MSG_PAGE, loadedCount + MSG_PAGE);
    const q = loadedMaxId ? `?limit=${limit}&before=${loadedMaxId + 1}` : `?limit=${MSG_PAGE}`;
    const d = await api(`/api/rooms/${encodeURIComponent(number)}/messages${q}`);
    const msgs = d.messages || [];
    chat.clear();
    exitSelect();
    hasMore = !!d.hasMore;
    loadedMaxId = msgs.length ? msgs[msgs.length - 1].id : null;
    oldestLoadedId = msgs.length ? msgs[0].id : null;
    loadedCount = msgs.length;
    seen.clear();
    for (const m of msgs) appendRoomMessage(m, m.sender_id === myUserId());
    chat.scroll();
    requestAnimationFrame(() => chat.scroll());
    setTimeout(() => chat.scroll(), 300);
    setTimeout(() => chat.scroll(), 900);
  }

  function memberDisplay(userId) {
    return currentMembers.find((x) => x.id === userId)?.displayName || null;
  }

  const fileCache = new Map();
  function fileById(id) {
    return fileCache.get(id);
  }

  async function sendText(text) {
    try {
      const d = await api(`/api/rooms/${encodeURIComponent(number)}/messages`, { method: 'POST', body: { content: text } });
      // 立即本地显示（接口返回真实消息 id），WS 回显到达时按 id 去重，避免等待回显
      if (d.message) {
        appendRoomMessage(d.message, true);
        chat.scroll();
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function uploadFiles(fileList, folderId) {
    if (!fileList.length) return;
    const upPerm = room?.uploadPermission || 'all';
    const isOwner = room && room.ownerId === myUserId();
    if (upPerm === 'owner' && !isOwner) return toast('仅房主可上传文件', 'error');
    if (upPerm === 'registered' && store.user?.role !== 'registered') return toast('仅登录用户可上传文件', 'error');
    const maxFileSize = Number(room?.maxFileSize || 10 * 1024 ** 3);
    const tooBig = [...fileList].find((f) => f.size > maxFileSize);
    if (tooBig) return toast(`文件 ${tooBig.name} 超过房主设置的单文件大小上限`, 'error');
    const expires = await chooseUploadOptions(fileList);
    if (expires === null) return;
    for (const file of fileList) {
      const wrap = el('div', { class: 'progress' }, [el('div')]);
      const chip = el('div', { class: 'file-chip' }, [
        el('span', { text: '📄' }),
        el('span', { class: 'fname', text: file.name }),
        wrap,
      ]);
      const bubble = el('div', { class: 'msg mine' }, [chip]);
      chat.body.append(bubble);
      chat.scroll();
      try {
        const d = await uploadWithProgress(
          `/api/rooms/${encodeURIComponent(number)}/files`,
          file,
          {
            headers: {
              'x-file-name': encodeURIComponent(file.name),
              'x-file-mime': encodeURIComponent(file.mime || file.type || 'application/octet-stream'),
              'x-expires': encodeURIComponent(expires),
              'x-folder': folderId ? String(folderId) : '',
            },
            onProgress: (r) => {
              wrap.firstChild.style.width = `${Math.round(r * 100)}%`;
            },
          }
        );
        bubble.remove();
        fileCache.set(d.file.id, d.file);
        appendRoomMessage({ ...d.message, file_id: d.file.id }, true);
      } catch (e) {
        bubble.remove();
        toast(e.message, 'error');
      }
    }
  }

  function chooseUploadOptions(fileList) {
    const isOwner = room && room.ownerId === myUserId();
    const maxDays = isOwner ? null : (room?.maxRetentionDays ?? null);
    const options = [
      { value: 'permanent', label: '永久', allowed: maxDays == null },
      { value: 'h1', label: '1 小时', allowed: true },
      { value: 'd1', label: '1 天', allowed: maxDays == null || maxDays >= 1 },
      { value: 'd7', label: '7 天', allowed: maxDays == null || maxDays >= 7 },
      { value: 'd30', label: '30 天', allowed: maxDays == null || maxDays >= 30 },
    ];
    return new Promise((resolve) => {
      const sel = el('select', {}, options.filter((o) => o.allowed).map((o) => el('option', { value: o.value, text: o.label })));
      const hint = maxDays == null ? '' : `房主限制：文件最长保存 ${maxDays} 天`;
      let m = null;
      m = modal({
        title: `上传 ${fileList.length} 个文件`,
        body: el('div', {}, [
          el('div', { class: 'form-group' }, [el('label', { text: '保存时长' }), sel]),
          hint ? el('div', { class: 'muted', text: hint }) : '',
        ]),
        actions: [
          { label: '取消', class: 'secondary', onClick: () => { resolve(null); m.close(); } },
          { label: '开始上传', class: 'ok', onClick: () => { resolve(sel.value); m.close(); } },
        ],
      });
    });
  }

  let rfState = { view: 'thumb', q: '', kind: 'all', folderId: null };

  async function showFiles() {
    const d = await api(`/api/rooms/${encodeURIComponent(number)}/files`);
    let folders = d.folders || [];
    let files = d.files || [];
    const me = myUserId();
    const isRoomOwner = room && room.ownerId === me;

    const upBtn = el('button', { class: 'btn secondary small rf-up', text: '↑', title: '返回上一层' });
    const searchInput = el('input', { type: 'text', placeholder: '搜索文件名…' });
    const kindSel = el('select', {}, [
      ['all', '全部'], ['image', '图片'], ['video', '视频'], ['voice', '语音'], ['file', '文件'],
    ].map(([v, t]) => el('option', { value: v, text: t })));
    const newFolderBtn = el('button', { class: 'btn small', text: '新建文件夹' });
    const refreshBtn = el('button', { class: 'btn secondary small', text: '刷新' });
    const fileInput = el('input', { type: 'file', multiple: true, class: 'hidden' });
    const pathEl = el('div', { class: 'rf-path' });
    const bodyWrap = el('div', { class: 'rf-body' });

    function updatePath() {
      pathEl.innerHTML = '';
      pathEl.append(el('a', {
        href: '#', text: '根目录',
        onClick: (e) => { e.preventDefault(); rfState.folderId = null; updatePath(); renderBody(); },
      }));
      const cur = folders.find((x) => x.id === rfState.folderId);
      if (cur) pathEl.append(el('span', { text: ' / ' }), el('span', { class: 'rf-path-cur', text: cur.name }));
      upBtn.disabled = rfState.folderId == null;
    }

    function fileActions(f) {
      const acts = [
        el('a', { class: 'small', href: '#', text: '下载', onClick: (e) => { e.preventDefault(); downloadRoomFile(f); } }),
      ];
      if (isRoomOwner) {
        acts.push(
          el('a', { class: 'small', href: '#', text: '重命名', onClick: (e) => { e.preventDefault(); renameFile(f); } }),
          el('a', { class: 'small', href: '#', text: '移动', onClick: (e) => { e.preventDefault(); moveFile(f); } }),
          el('a', { class: 'small', href: '#', text: '删除', onClick: (e) => { e.preventDefault(); deleteFile(f); } }),
        );
      }
      return acts;
    }

    /** 当前上下文可见的文件夹：根目录下显示全部，进入文件夹后无子级 */
    function foldersInView() {
      if (rfState.folderId != null) return [];
      const q = rfState.q.trim().toLowerCase();
      return folders.filter((f) => !q || f.name.toLowerCase().includes(q));
    }

    function folderActions(fld) {
      if (!isRoomOwner) return [el('span', { class: 'muted small', text: '点击进入' })];
      return [
        el('a', { class: 'small', href: '#', text: '重命名', onClick: (e) => { e.preventDefault(); e.stopPropagation(); renameFolder(fld); } }),
        el('a', { class: 'small', href: '#', text: '删除', onClick: (e) => { e.preventDefault(); e.stopPropagation(); deleteFolder(fld); } }),
      ];
    }

    function buildFolderCard(fld) {
      const card = el('div', { class: 'file-card rf-folder-card' });
      card.append(
        el('div', { class: 'preview' }, [el('span', { class: 'rf-folder-icon', text: '📁' })]),
        el('div', { class: 'info' }, [
          el('div', { class: 'fn', title: fld.name, text: fld.name }),
          el('div', { class: 'muted', text: '文件夹' }),
          el('div', { class: 'row', style: 'margin-top:6px' }, folderActions(fld)),
        ])
      );
      card.addEventListener('click', () => {
        rfState.folderId = fld.id;
        updatePath();
        renderBody();
      });
      return card;
    }

    function buildFileCard(f) {
      const card = el('div', { class: 'file-card' });
      const preview = el('div', { class: 'preview' });
      if (f.expired) {
        preview.append(el('span', { class: 'muted', text: '⏳' }));
        card.append(preview, el('div', { class: 'info' }, [
          el('div', { class: 'fn', text: f.filename }),
          el('div', { text: '该文件已过期' }),
          el('div', { class: 'muted', text: `上传时间：${fmtTime(f.createdAt)}` }),
        ]));
        return card;
      }
      if (!f.ready) {
        preview.append(el('span', { class: 'muted', text: '⏳ 处理中…' }));
      } else if (f.kind === 'image') {
        const img = el('img');
        preview.append(img);
        img.addEventListener('click', () => openImageViewer(f));
        loadThumbOrOriginal(f, img);
      } else if (f.kind === 'video') {
        const v = el('video', { muted: true, controls: false });
        preview.append(v);
        loadPreviewOrOriginal(f, v);
      } else {
        if (f.kind === 'voice') {
          const sp = el('span', { class: 'muted', text: '🎙️' });
          preview.classList.add('rf-voice-preview');
          preview.append(sp);
          preview.addEventListener('click', () => openVoicePreview(f));
        } else {
          preview.append(el('span', { class: 'muted', text: '📄' }));
        }
      }
      card.append(preview, el('div', { class: 'info' }, [
        el('div', { class: 'fn', title: f.filename, text: f.filename }),
        el('div', { class: 'muted', text: `${fmtBytes(f.size)} · ${f.expiresAt ? '过期 ' + fmtTime(f.expiresAt) : '永久'}` }),
        el('div', { class: 'row', style: 'margin-top:6px' }, fileActions(f)),
      ]));
      return card;
    }

    function buildFileTable(list, dirs) {
      const table = el('table', {}, [
        el('thead', {}, [el('tr', {}, ['名称', '类型', '大小', '上传者', '上传时间', '操作'].map((t) => el('th', { text: t })))]),
      ]);
      for (const fld of dirs) {
        const acts = isRoomOwner ? [
          el('a', { class: 'small', href: '#', text: '重命名', onClick: (e) => { e.preventDefault(); renameFolder(fld); } }),
          el('a', { class: 'small', href: '#', text: '删除', onClick: (e) => { e.preventDefault(); deleteFolder(fld); } }),
        ] : [];
        table.append(el('tbody', {}, [el('tr', {}, [
          el('td', {}, [el('a', { href: '#', text: `📁 ${fld.name}`, onClick: (e) => { e.preventDefault(); rfState.folderId = fld.id; updatePath(); renderBody(); } })]),
          el('td', { text: '文件夹' }),
          el('td', { text: '—' }),
          el('td', { text: '—' }),
          el('td', { text: fmtTime(fld.createdAt) }),
          el('td', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, acts),
        ])]));
      }
      for (const f of list) {
        table.append(el('tbody', {}, [el('tr', {}, [
          el('td', { title: f.filename, text: f.filename }),
          el('td', { text: f.kind === 'voice' ? '语音' : f.kind === 'image' ? '图片' : f.kind === 'video' ? '视频' : '文件' }),
          el('td', { text: fmtBytes(f.size) }),
          el('td', { text: memberDisplay(f.ownerId) || `用户#${f.ownerId}` }),
          el('td', { text: fmtTime(f.createdAt) }),
          el('td', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, fileActions(f)),
        ])]));
      }
      return table;
    }

    function renderBody() {
      bodyWrap.innerHTML = '';
      const q = rfState.q.trim().toLowerCase();
      const list = files.filter((f) => {
        if (f.status === 'deleted') return false;
        if (!f.ready && f.ownerId !== me) return false;
        if (rfState.folderId == null ? f.folderId != null : f.folderId !== rfState.folderId) return false;
        if (rfState.kind !== 'all' && f.kind !== rfState.kind) return false;
        if (q && !f.filename.toLowerCase().includes(q)) return false;
        return true;
      });
      const dirs = foldersInView();
      if (!list.length && !dirs.length) {
        bodyWrap.append(el('div', { class: 'empty', text: '没有符合条件的文件' }));
        return;
      }
      if (rfState.view === 'thumb') {
        const grid = el('div', { class: 'room-files' });
        for (const fld of dirs) grid.append(buildFolderCard(fld));
        for (const f of list) grid.append(buildFileCard(f));
        bodyWrap.append(grid);
      } else {
        bodyWrap.append(buildFileTable(list, dirs));
      }
    }

    // 预览失败时回退到原始文件，保证没有 ffmpeg 的环境也能看图/视频
    async function loadThumbOrOriginal(f, img) {
      try {
        const b = await downloadBlob(`/api/files/${f.id}/thumb`);
        img.src = URL.createObjectURL(b);
      } catch {
        try {
          const b = await downloadBlob(f.url);
          img.src = URL.createObjectURL(b);
        } catch { /* ignore */ }
      }
    }
    function loadPreviewOrOriginal(f, v) {
      // 流式加载：仅加载元数据，点击播放后才拉取内容
      v.preload = 'none';
      v.src = mediaUrl(f.url.replace('/download', '/preview'));
      v.addEventListener('error', () => {
        const orig = mediaUrl(f.url);
        if (v.src !== orig) v.src = orig;
      });
      v.addEventListener('click', () => {
        if (v.paused) v.play().catch(() => {});
        else v.pause();
      });
    }

    async function refresh() {
      try {
        const d2 = await api(`/api/rooms/${encodeURIComponent(number)}/files`);
        folders = d2.folders || [];
        files = d2.files || [];
        for (const f of files) fileCache.set(f.id, f);
        updatePath();
        renderBody();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function createFolder() {
      if (!isRoomOwner) return toast('只有房主可以创建文件夹', 'error');
      const input = el('input', { type: 'text', placeholder: '文件夹名称' });
      let m = null;
      m = modal({
        title: '新建文件夹',
        body: input,
        actions: [
          { label: '取消', class: 'secondary', onClick: () => m.close() },
          { label: '创建', class: 'ok', onClick: async () => {
            try {
              await api(`/api/rooms/${encodeURIComponent(number)}/folders`, { method: 'POST', body: { name: input.value } });
              m.close();
              refresh();
            } catch (e) { toast(e.message, 'error'); }
          } },
        ],
      });
    }

    async function renameFolder(f) {
      if (!isRoomOwner) return toast('只有房主可以管理文件夹', 'error');
      const input = el('input', { type: 'text', value: f.name });
      let m = null;
      m = modal({
        title: '重命名文件夹',
        body: input,
        actions: [
          { label: '取消', class: 'secondary', onClick: () => m.close() },
          { label: '保存', class: 'ok', onClick: async () => {
            try {
              await api(`/api/rooms/${encodeURIComponent(number)}/folders/${f.id}`, { method: 'PUT', body: { name: input.value } });
              m.close();
              refresh();
            } catch (e) { toast(e.message, 'error'); }
          } },
        ],
      });
    }

    async function deleteFolder(f) {
      if (!isRoomOwner) return toast('只有房主可以管理文件夹', 'error');
      const otherFolders = folders.filter((x) => x.id !== f.id);
      const modeSel = el('select', {}, [
        el('option', { value: 'root', text: '移回根目录' }),
        el('option', { value: 'delete', text: '直接删除文件夹中的文件' }),
        ...(otherFolders.length ? [el('option', { value: 'move', text: '移动到其他文件夹' })] : []),
      ]);
      const moveSel = el('select', {}, otherFolders.map((x) => el('option', { value: String(x.id), text: x.name })));
      const moveWrap = el('div', { class: 'form-group hidden', style: 'margin-top:8px' }, [
        el('label', { text: '目标文件夹' }),
        moveSel,
      ]);
      modeSel.addEventListener('change', () => moveWrap.classList.toggle('hidden', modeSel.value !== 'move'));
      const choice = await new Promise((resolve) => {
        const m = modal({
          title: `删除文件夹「${f.name}」`,
          body: el('div', {}, [
            el('div', { class: 'form-group' }, [el('label', { text: '文件夹中的文件' }), modeSel]),
            moveWrap,
          ]),
          actions: [
            { label: '取消', class: 'secondary', onClick: () => { resolve(null); m.close(); } },
            { label: '确定', class: 'danger', onClick: () => { resolve({ mode: modeSel.value, targetFolderId: moveSel.value }); m.close(); } },
          ],
        });
      });
      if (!choice) return;
      if (choice.mode === 'move' && !choice.targetFolderId) return toast('请选择目标文件夹', 'error');
      if (choice.mode === 'delete') {
        if (!(await confirmDialog('确认删除', '文件夹中的文件将被永久删除，此操作不可恢复。确定继续吗？', '删除', true))) return;
      }
      try {
        await api(`/api/rooms/${encodeURIComponent(number)}/folders/${f.id}`, {
          method: 'DELETE',
          body: { mode: choice.mode, targetFolderId: choice.mode === 'move' ? Number(choice.targetFolderId) : undefined },
        });
        if (rfState.folderId === f.id) rfState.folderId = null;
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function renameFile(f) {
      if (!isRoomOwner) return toast('只有房主可以重命名文件', 'error');
      const input = el('input', { type: 'text', value: f.filename });
      let m = null;
      m = modal({
        title: '重命名文件',
        body: input,
        actions: [
          { label: '取消', class: 'secondary', onClick: () => m.close() },
          { label: '保存', class: 'ok', onClick: async () => {
            try {
              const d = await api(`/api/rooms/${encodeURIComponent(number)}/files/${f.id}/rename`, { method: 'POST', body: { name: input.value } });
              fileCache.set(f.id, d.file);
              chat.updateFile(d.file);
              m.close();
              refresh();
            } catch (e) { toast(e.message, 'error'); }
          } },
        ],
      });
    }

    async function moveFile(f) {
      if (!isRoomOwner) return toast('只有房主可以移动文件', 'error');
      const sel = el('select', {}, [
        el('option', { value: '', text: '根目录' }),
        ...folders.filter((x) => x.id !== f.folderId).map((x) => el('option', { value: String(x.id), text: x.name })),
      ]);
      sel.value = f.folderId == null ? '' : String(f.folderId);
      let m = null;
      m = modal({
        title: `移动文件：${f.filename}`,
        body: sel,
        actions: [
          { label: '取消', class: 'secondary', onClick: () => m.close() },
          { label: '移动', class: 'ok', onClick: async () => {
            try {
              const d = await api(`/api/rooms/${encodeURIComponent(number)}/files/${f.id}/move`, { method: 'POST', body: { folderId: sel.value === '' ? null : Number(sel.value) } });
              fileCache.set(f.id, d.file);
              chat.updateFile(d.file);
              m.close();
              refresh();
            } catch (e) { toast(e.message, 'error'); }
          } },
        ],
      });
    }

    async function deleteFile(f) {
      if (!isRoomOwner) return toast('只有房主可以删除文件', 'error');
      if (!(await confirmDialog('删除文件', `确定删除 ${f.filename} 吗？`, '删除', true))) return;
      try {
        await api(`/api/rooms/${encodeURIComponent(number)}/files/${f.id}`, { method: 'DELETE' });
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    }

    function openVoicePreview(f) {
      const audio = new Audio();
      audio.preload = 'none';
      audio.src = mediaUrl(f.url);
      openVoicePlayer(f, audio);
    }

    function refreshViewBtns() {
      if (!mm) return;
      for (const b of mm.box.querySelectorAll('.rf-view')) {
        b.classList.toggle('active', b.textContent === (rfState.view === 'thumb' ? '缩略图' : '列表'));
      }
    }

    const switchView = (v) => { rfState.view = v; refreshViewBtns(); renderBody(); };
    upBtn.addEventListener('click', () => { rfState.folderId = null; updatePath(); renderBody(); });
    searchInput.addEventListener('input', () => { rfState.q = searchInput.value; renderBody(); });
    kindSel.addEventListener('change', () => { rfState.kind = kindSel.value; renderBody(); });
    newFolderBtn.addEventListener('click', createFolder);
    refreshBtn.addEventListener('click', refresh);
    fileInput.addEventListener('change', async () => {
      const list = [...fileInput.files];
      fileInput.value = '';
      ws.setFilePick(false);
      if (!list.length) return;
      try {
        await uploadFiles(list, rfState.folderId); // 多选一次性批量上传（一个保存时长弹窗、显示数量）
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    });

    // 文件管理弹窗支持拖放上传到当前文件夹
    const rfWrap = el('div', { class: 'rf-wrap' }, [
      el('div', { class: 'rf-toolbar' }, [upBtn, pathEl, newFolderBtn]),
      el('div', { class: 'rf-toolbar rf-toolbar2' }, [kindSel, searchInput, refreshBtn]),
      fileInput,
      bodyWrap,
    ]);
    let dragDepth = 0;
    const setDrag = (on) => rfWrap.classList.toggle('drag-over', on);
    rfWrap.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragDepth++;
      setDrag(true);
    });
    rfWrap.addEventListener('dragover', (e) => e.preventDefault());
    rfWrap.addEventListener('dragleave', () => {
      if (--dragDepth <= 0) {
        dragDepth = 0;
        setDrag(false);
      }
    });
    rfWrap.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      setDrag(false);
      const list = [...(e.dataTransfer?.files || [])];
      if (!list.length) return;
      try {
        await uploadFiles(list, rfState.folderId);
        refresh();
      } catch (err) { toast(err.message, 'error'); }
    });

    const mm = modal({
      title: `房间文件（${number}）`,
      className: 'modal-wide',
      body: rfWrap,
      actions: [
        { label: '缩略图', class: 'secondary small rf-view', onClick: () => switchView('thumb') },
        { label: '列表', class: 'secondary small rf-view', onClick: () => switchView('list') },
        { label: '上传到此处', class: 'ok', onClick: () => fileInput.click() },
        { label: '关闭', class: 'secondary', onClick: () => mm.close() },
      ],
    });
    refreshViewBtns();
    updatePath();
    renderBody();
  }

  async function downloadRoomFile(f) {
    try {
      const { saveRemoteFile } = await import('./chat.js');
      await saveRemoteFile(f, f.filename);
    } catch (e) { toast(e.message, 'error'); }
  }

  const offs = [];
  offs.push(ws.on('roomMessage', (m) => {
    if (m.number !== number) return;
    if (m.file) fileCache.set(m.file.id, m.file);
    appendRoomMessage(m.message, m.message.sender_id === myUserId());
    if (m.message.id > (loadedMaxId || 0)) loadedMaxId = m.message.id;
    loadedCount++;
  }));
  offs.push(ws.on('roomFileReady', (m) => {
    if (m.number !== number) return;
    fileCache.set(m.file.id, m.file);
    chat.updateFile(m.file);
  }));
  offs.push(ws.on('roomFileDeleted', (m) => {
    if (m.number !== number) return;
    const f = fileCache.get(m.fileId) || { id: m.fileId, filename: '文件' };
    f.status = 'deleted';
    fileCache.set(m.fileId, f);
    chat.updateFile(f);
  }));
  offs.push(ws.on('roomFileUpdated', (m) => {
    if (m.number !== number) return;
    fileCache.set(m.file.id, m.file);
    chat.updateFile(m.file);
  }));
  offs.push(ws.on('roomMessagesDeleted', (m) => {
    if (m.number !== number) return;
    chat.removeMessages(m.messageIds || []);
    for (const fid of m.fileIds || []) {
      const f = fileCache.get(fid);
      if (f) {
        f.status = 'deleted';
        fileCache.set(fid, f);
      }
    }
  }));
  offs.push(ws.on('roomMessagesRestored', (m) => {
    if (m.number !== number) return;
    reloadVisibleMessages().catch((e) => toast(e.message, 'error'));
  }));
  offs.push(ws.on('roomMembers', (m) => {
    if (m.number === number && m.members) renderMembers(m.members);
  }));
  offs.push(ws.on('roomDestroyed', (m) => {
    if (m.number !== number) return;
    ws.send({ type: 'roomLeave', number });
    location.hash = '#/rooms';
  }));
  offs.push(ws.on('roomApproved', (m) => {
    if (m.number !== number) return;
    toast('房间号已审批通过');
    location.reload();
  }));
  offs.push(ws.on('roomNotice', (m) => {
    if (m.number !== number) return;
    toast(m.content, 'info', 2000);
  }));

  init().catch((e) => toast(e.message, 'error'));
  return () => offs.forEach((f) => f());
}

export function viewSettings(container) {
  container.innerHTML = '';
  const root = el('div', { class: 'container' });
  container.append(root);
  const me = store.user || {};

  const uuidInput = el('input', { type: 'text', value: me.uuid || '', disabled: true });
  const usernameInput = el('input', { type: 'text', value: me.username || '' });
  const nicknameInput = el('input', { type: 'text', value: me.nickname || '' });
  const curPw = el('input', { type: 'password', placeholder: '当前密码' });
  const newPw = el('input', { type: 'password', placeholder: '新密码（留空不修改）' });
  const profileMsg = el('div', { class: 'muted', style: 'margin-top:8px' });
  const profilePanel = el('div', { class: 'panel', style: 'margin-bottom:14px' }, [
    el('h3', { style: 'margin-bottom:12px', text: '个人资料' }),
    el('div', { class: 'form-group' }, [el('label', { text: '用户 UUID（不可修改）' }), uuidInput]),
    el('div', { class: 'form-group' }, [el('label', { text: '用户名' }), usernameInput]),
    el('div', { class: 'form-group' }, [el('label', { text: '昵称' }), nicknameInput]),
    el('div', { class: 'form-group' }, [el('label', { text: '当前密码' }), curPw]),
    el('div', { class: 'form-group' }, [el('label', { text: '新密码' }), newPw]),
    el('button', {
      class: 'btn',
      text: '保存',
      onClick: async () => {
        try {
          const d = await api('/api/auth/update-profile', {
            method: 'POST',
            body: {
              username: usernameInput.value,
              nickname: nicknameInput.value,
              currentPassword: curPw.value,
              newPassword: newPw.value || undefined,
            },
          });
          const { saveAuth } = await import('./state.js');
          saveAuth(store.token, { ...store.user, username: d.user.username, nickname: d.user.nickname });
          profileMsg.textContent = '已保存';
          window.dispatchEvent(new Event('wd-refresh'));
        } catch (e) {
          profileMsg.textContent = e.message;
        }
      },
    }),
    profileMsg,
  ]);

  const devWrap = el('div');
  const devPanel = el('div', { class: 'panel' }, [
    el('h3', { style: 'margin-bottom:12px', text: '我的设备' }),
    devWrap,
  ]);

  // 主题
  const themeWrap = el('div');
  const themeFileInput = el('input', { type: 'file', accept: '.zip', class: 'hidden' });
  const themePanel = el('div', { class: 'panel', style: 'margin-top:14px' }, [
    el('h3', { style: 'margin-bottom:12px', text: '主题' }),
    el('div', { class: 'row', style: 'margin-bottom:10px' }, [
      el('button', { class: 'btn', text: '上传主题包', onClick: () => themeFileInput.click() }),
      el('button', {
        class: 'btn secondary small',
        text: '下载示例主题',
        onClick: async () => {
          try {
            const res = await fetch('/api/themes/template');
            if (!res.ok) throw new Error('模板下载失败');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = el('a', { href: url, download: 'webdrop-theme-template.zip' });
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
          } catch (e) { toast(e.message, 'error'); }
        },
      }),
      themeFileInput,
      el('span', { class: 'muted', text: '支持上传 zip 主题包（个人主题保存在独立目录，注销时删除）' }),
    ]),
    themeWrap,
  ]);
  root.append(profilePanel, themePanel, devPanel);

  async function loadDevices() {
    try {
      const d = await api('/api/auth/devices');
      const currentId = (store.myDeviceKey || '').split(':')[2] || '';
      devWrap.innerHTML = '';
      if (!d.devices.length) {
        devWrap.append(el('div', { class: 'muted', text: '暂无设备记录' }));
        return;
      }
      const table = el('table', {}, [
        el('thead', {}, [el('tr', {}, ['设备', '浏览器', '机型', '最后上线', '状态', '操作'].map((t) => el('th', { text: t })))]),
      ]);
      for (const dev of d.devices) {
        const isCurrent = dev.deviceId === currentId;
        const actions = [];
        if (!isCurrent) {
          actions.push(el('button', {
            class: 'btn secondary small',
            text: '下线',
            onClick: async () => {
              try {
                await api(`/api/auth/devices/${dev.deviceId}/logout`, { method: 'POST', body: {} });
                loadDevices();
                toast('已将该设备下线');
              } catch (e) { toast(e.message, 'error'); }
            },
          }));
        }
        if (!isCurrent && dev.status !== 'blacklisted') {
          actions.push(el('button', {
            class: 'btn danger small',
            text: '拉黑',
            onClick: async () => {
              if (!(await confirmDialog('拉黑设备', `拉黑后该设备（${dev.deviceId.slice(0, 8)}…）将无法登录，确定吗？`, '拉黑', true))) return;
              try {
                await api(`/api/auth/devices/${dev.deviceId}/blacklist`, { method: 'POST', body: {} });
                loadDevices();
                toast('已拉黑该设备');
              } catch (e) { toast(e.message, 'error'); }
            },
          }));
        }
        if (dev.status === 'blacklisted') {
          actions.push(el('button', {
            class: 'btn ok small',
            text: '解除拉黑',
            onClick: async () => {
              try {
                await api(`/api/auth/devices/${dev.deviceId}/unblacklist`, { method: 'POST', body: {} });
                loadDevices();
              } catch (e) { toast(e.message, 'error'); }
            },
          }));
        }
        table.append(el('tbody', {}, [
          el('tr', {}, [
            el('td', {}, [
              el('div', { text: dev.name || '设备' }),
              el('div', { class: 'muted', style: 'font-size:11px;word-break:break-all', text: dev.deviceId }),
            ]),
            el('td', { text: dev.browser || '-' }),
            el('td', { text: dev.model || '-' }),
            el('td', { text: fmtTime(dev.lastSeenAt) }),
            el('td', {}, [el('span', { class: `badge ${dev.status === 'blacklisted' ? 'danger' : isCurrent ? 'ok' : 'muted'}`, text: dev.status === 'blacklisted' ? '已拉黑' : isCurrent ? '当前设备' : '正常' })]),
            el('td', { class: 'row', style: 'gap:6px' }, actions),
          ]),
        ]));
      }
      devWrap.append(el('div', { class: 'table-scroll' }, [table]));
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  async function loadThemes() {
    const d = await listThemes();
    const userPref = store.user?.theme || 'default';
    const followGlobal = userPref === 'default' || userPref === '';
    themeWrap.innerHTML = '';
    const grid = el('div', { class: 'theme-list' });

    const followCard = el('div', { class: `card theme-card${followGlobal ? ' selected' : ''}` }, [
      el('div', { class: 'theme-card-name', style: 'font-weight:600', text: `跟随全局（默认）${followGlobal ? ' ✓' : ''}` }),
      el('div', { class: 'muted', text: '跟随管理员设置的全局主题' }),
    ]);
    followCard.addEventListener('click', async () => {
      try {
        const g = await api('/api/themes/global');
        const t = parseTheme(g.theme);
        let m;
        m = openThemePreview(t, {
          name: '跟随全局（默认）',
          version: '-',
          author: '-',
          description: '跟随管理员设置的全局主题',
        }, {
          actions: [{
            label: '使用',
            class: 'ok',
            onClick: async () => {
              try {
                store.user = { ...store.user, theme: 'default' };
                await api('/api/auth/theme', { method: 'POST', body: { theme: 'default' } });
                m.close();
                loadThemes();
                toast('已跟随全局主题');
              } catch (e) { toast(e.message, 'error'); }
            },
          }],
        });
      } catch (e) { toast(e.message, 'error'); }
    });
    grid.append(followCard);

    for (const t of d.themes) {
      const pref = `${t.source}:${t.name}`;
      const selected = !followGlobal && userPref === pref;
      const delBtn = t.deletable ? el('button', {
        class: 'theme-del',
        title: '删除主题',
        text: '×',
        onClick: async (e) => {
          e.stopPropagation();
          if (!(await confirmDialog('删除主题', `确定删除主题 ${t.name} 吗？`, '删除', true))) return;
          try {
            await deleteTheme(t.name);
            loadThemes();
          } catch (e) { toast(e.message, 'error'); }
        },
      }) : null;
      const card = el('div', { class: `card theme-card${selected ? ' selected' : ''}` }, [
        ...(delBtn ? [delBtn] : []),
        el('div', { class: 'theme-card-name', style: 'font-weight:600', text: `${t.name}${selected ? ' ✓' : ''}` }),
        el('div', { class: 'muted', text: `版本 ${t.version} · 作者 ${t.author}` }),
        el('div', { class: 'muted small', text: t.description || '' }),
      ]);
      card.addEventListener('click', () => {
        const m = openThemePreview(t, t, {
          actions: [{
            label: '使用',
            class: 'ok',
            onClick: async () => {
              try {
                await applyTheme(t);
                store.user = { ...store.user, theme: pref };
                await api('/api/auth/theme', { method: 'POST', body: { theme: pref } });
                m.close();
                loadThemes();
                toast('主题已切换');
              } catch (e) { toast(e.message, 'error'); }
            },
          }],
        });
      });
      grid.append(card);
    }
    themeWrap.append(grid);
  }
  themeFileInput.addEventListener('change', async () => {
    const f = themeFileInput.files[0];
    themeFileInput.value = '';
    if (!f) return;
    try {
      await uploadTheme(f);
      toast('主题上传成功');
      loadThemes();
    } catch (e) { toast(e.message, 'error'); }
  });
  loadThemes();
  loadDevices();
}
