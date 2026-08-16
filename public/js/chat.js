import { el, fmtBytes, fmtClock, toast, modal } from './util.js';
import { downloadBlob, fetchWithProgress } from './api.js';
import { store } from './state.js';

const urlCache = new Map();
const voicePlayers = new Map(); // fileUrl -> overlay：同一音频只允许一个播放器窗口

/** 媒体流式 URL：携带会话凭证，video/audio 标签可直接播放，按需加载（支持 Range） */
export function mediaUrl(path) {
  const q = path.includes('?') ? '&' : '?';
  if (store.token) return `${path}${q}token=${encodeURIComponent(store.token)}`;
  if (store.tempId) return `${path}${q}temp=${encodeURIComponent(store.tempId)}`;
  return path;
}

async function authedUrl(path) {
  if (urlCache.has(path)) return urlCache.get(path);
  const blob = await downloadBlob(path);
  const url = URL.createObjectURL(blob);
  urlCache.set(path, url);
  return url;
}

export async function saveRemoteFile(file, fallbackName) {
  const name = file.filename || fallbackName || 'download';
  const sizeTxt = file.size ? fmtBytes(file.size) : '';
  const bar = el('div', { class: 'progress' }, [el('div')]);
  const ac = new AbortController();
  const m = modal({
    title: '下载文件',
    body: el('div', {}, [
      el('div', { class: 'muted', style: 'margin-bottom:8px;word-break:break-all', text: `${name}${sizeTxt ? '（' + sizeTxt + '）' : ''}` }),
      bar,
    ]),
    actions: [{ label: '取消下载', class: 'danger', onClick: () => ac.abort() }],
  });
  try {
    const blob = await fetchWithProgress(file.url, {
      signal: ac.signal,
      onProgress: (r) => { if (r != null) bar.firstChild.style.width = `${Math.round(r * 100)}%`; },
    });
    m.close();
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(`已下载：${name}`);
  } catch (e) {
    m.close();
    if (e && e.name === 'AbortError') {
      toast('已取消下载');
      return;
    }
    toast(e.message, 'error');
  }
}

function fmtDur(s) {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

/** 图片放大查看（替代直接打开/下载原图） */
export function openImageViewer(file) {
  if (document.querySelector('.image-viewer')) return;
  const overlay = el('div', { class: 'image-viewer' });
  const img = el('img', { class: 'iv-img', alt: file.filename || '图片' });
  const closeBtn = el('button', { class: 'iv-close', text: '✕' });
  overlay.append(closeBtn, img);
  document.body.append(overlay);
  authedUrl(file.url).then((u) => { img.src = u; }).catch((e) => toast(e.message, 'error'));
  const close = () => overlay.remove();
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const onKey = (e) => { if (e.key === 'Escape') { close(); window.removeEventListener('keydown', onKey); } };
  window.addEventListener('keydown', onKey);
}

/** 专用语音播放器：手机全屏、桌面浮窗（可拖动）；与气泡共用同一音频实例 */
export function openVoicePlayer(file, audio) {
  const name = file.filename || '语音';
  const key = file.url || file.id;
  if (key && voicePlayers.has(key)) return;
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const overlay = el('div', { class: `voice-player ${isMobile ? 'fullscreen' : 'float'}` });
  const closeBtn = el('button', { class: 'vp-close', text: '✕' });
  const head = el('div', { class: 'vp-head' }, [
    el('div', { class: 'vp-title', text: name }),
    closeBtn,
  ]);
  const curTxt = el('span', { class: 'vp-cur', text: '0:00' });
  const durTxt = el('span', { class: 'vp-dur', text: '0:00' });
  const bar = el('div', { class: 'vp-bar' });
  const fill = el('div', { class: 'vp-fill' });
  bar.append(fill);
  const playBtn = el('button', { class: 'btn vp-play', text: '▶' });
  const backBtn = el('button', { class: 'btn secondary small vp-5', text: '⟲ 5s' });
  const fwdBtn = el('button', { class: 'btn secondary small vp-5', text: '5s ⟳' });
  const replayBtn = el('button', { class: 'btn secondary small', text: '↺ 重播' });
  const dlBtn = el('button', { class: 'btn secondary small', text: '下载' });
  overlay.append(
    head,
    el('div', { class: 'vp-time' }, [curTxt, durTxt]),
    bar,
    el('div', { class: 'vp-controls' }, [backBtn, playBtn, fwdBtn]),
    el('div', { class: 'vp-extra' }, [replayBtn, dlBtn]),
  );
  document.body.append(overlay);
  overlay._audio = audio;
  if (key) voicePlayers.set(key, overlay);

  audio.preload = 'none';
  const sync = () => {
    playBtn.textContent = audio.paused ? '▶' : '⏸';
    const d = audio.duration || 0;
    const c = audio.currentTime || 0;
    durTxt.textContent = fmtDur(d);
    curTxt.textContent = fmtDur(c);
    fill.style.width = d ? `${Math.min(100, (c / d) * 100)}%` : '0%';
  };
  audio.addEventListener('timeupdate', sync);
  audio.addEventListener('loadedmetadata', sync);
  audio.addEventListener('play', sync);
  audio.addEventListener('pause', sync);
  audio.addEventListener('ended', () => { playBtn.textContent = '↺'; sync(); });

  const toggle = async () => {
    try {
      if (!audio.currentSrc) return toast('语音尚未加载完成，请稍后重试', 'error');
      if (audio.paused) await audio.play();
      else audio.pause();
    } catch (e) { toast(e.message, 'error'); }
  };
  playBtn.addEventListener('click', toggle);
  backBtn.addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 5); sync(); });
  fwdBtn.addEventListener('click', () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5); sync(); });
  replayBtn.addEventListener('click', () => { audio.currentTime = 0; sync(); audio.play().catch(() => {}); });
  dlBtn.addEventListener('click', () => saveRemoteFile(file, name).catch((e) => toast(e.message, 'error')));

  // 拖拽进度条
  let scrubbing = false;
  const seekFrom = (e) => {
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    if (audio.duration) { audio.currentTime = ratio * audio.duration; sync(); }
  };
  bar.addEventListener('pointerdown', (e) => { scrubbing = true; bar.setPointerCapture(e.pointerId); seekFrom(e); });
  bar.addEventListener('pointermove', (e) => { if (scrubbing) seekFrom(e); });
  bar.addEventListener('pointerup', () => { scrubbing = false; });

  // 桌面浮窗可拖动
  if (!isMobile) {
    // 默认从屏幕中间出现，随机偏移 50-100px（夹在视口内），避免藏在角落
    const w = overlay.offsetWidth || 380;
    const h = overlay.offsetHeight || 260;
    const cx = Math.max(8, (window.innerWidth - w) / 2);
    const cy = Math.max(8, (window.innerHeight - h) / 2);
    const dir = () => (Math.random() < 0.5 ? -1 : 1);
    const ox = dir() * (50 + Math.random() * 50);
    const oy = dir() * (50 + Math.random() * 50);
    overlay.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, cx + ox))}px`;
    overlay.style.top = `${Math.min(window.innerHeight - h - 8, Math.max(8, cy + oy))}px`;
    overlay.style.transform = 'none';
    let drag = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.vp-close')) return; // 关闭按钮不触发拖动，保证点击可用
      const r = overlay.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      overlay.style.left = `${r.left}px`;
      overlay.style.top = `${r.top}px`;
      overlay.style.transform = 'none';
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      overlay.style.left = `${e.clientX - drag.dx}px`;
      overlay.style.top = `${e.clientY - drag.dy}px`;
    });
    head.addEventListener('pointerup', () => { drag = null; });
  }

  const close = () => {
    audio.pause();
    overlay.remove();
    if (key) voicePlayers.delete(key);
  };
  closeBtn.addEventListener('click', close);
}

export class ChatView {
  constructor({ title, onText, onFiles, onVoice, onFilePick }) {
    this.title = title;
    this.onText = onText;
    this.onFiles = onFiles;
    this.onVoice = onVoice;
    this.onFilePick = onFilePick;
    this.fileTransfers = new Map(); // transferId -> bubble state
    this.fileBubbles = new Map(); // fileId -> bubble
    this.messageBubbles = new Map(); // messageId -> bubble
    this.selectMode = false;
    this.selected = new Set();
    this.onSelectChange = null;
    this.root = el('div', { class: 'chat-wrap' });
    this.head = el('div', { class: 'chat-head' }, [el('div', { class: 'grow', text: title }), el('div', { class: 'muted', id: 'chat-sub' })]);
    this.body = el('div', { class: 'chat-body' });
    this.root.append(this.head, this.body);
    this.buildInput();
    this.setupDragDrop();
  }

  /** 桌面端拖拽文件到聊天区直接发送 */
  setupDragDrop() {
    let depth = 0;
    this.root.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      this.root.classList.add('drag-over');
    });
    this.root.addEventListener('dragover', (e) => e.preventDefault());
    this.root.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        this.root.classList.remove('drag-over');
      }
    });
    this.root.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      this.root.classList.remove('drag-over');
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) this.onFiles?.(files);
    });
  }

  buildInput() {
    this.textInput = el('input', { type: 'text', placeholder: '输入消息…' });
    this.sendBtn = el('button', { class: 'btn small', text: '发送' });
    this.fileBtn = el('button', { class: 'btn secondary small', text: '📎 文件' });
    this.voiceBtn = el('button', { class: 'btn secondary small', text: '🎤 语音' });
    this.fileInput = el('input', { type: 'file', multiple: true, class: 'hidden' });
    this.recLabel = el('span', { class: 'muted hidden' });
    const bar = el('div', { class: 'chat-input' }, [
      this.textInput,
      this.sendBtn,
      this.fileBtn,
      this.fileInput,
      this.voiceBtn,
      this.recLabel,
    ]);
    this.root.append(bar);

    const submit = () => {
      const v = this.textInput.value.trim();
      if (!v) return;
      this.textInput.value = '';
      this.onText?.(v);
    };
    this.sendBtn.addEventListener('click', submit);
    this.textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    this.fileBtn.addEventListener('click', () => {
      this.onFilePick?.(true);
      this.fileInput.click();
    });
    this.fileInput.addEventListener('change', () => {
      // 先快照成数组，避免清空 input 后 live FileList 失效
      const files = Array.from(this.fileInput.files);
      if (files.length) this.onFiles?.(files);
      this.onFilePick?.(false);
      this.fileInput.value = '';
    });
    this.voiceBtn.addEventListener('click', () => this.toggleRecord());
  }

  async toggleRecord() {
    if (this.recording) {
      const blob = await this.stopRecord();
      this.recLabel.classList.add('hidden');
      this.voiceBtn.textContent = '🎤 语音';
      if (blob) this.onVoice?.(blob);
      return;
    }
    const { recordAudio } = await import('./recorder.js');
    try {
      const r = await recordAudio();
      this.recording = r;
      this.recLabel.classList.remove('hidden');
      this.recLabel.innerHTML = '<span class="rec-dot"></span> 录制中，点击停止';
      this.voiceBtn.textContent = '⏹ 停止';
    } catch (e) {
      this.voiceBtn.textContent = '🎤 语音';
      this.recLabel.classList.add('hidden');
      toast(e.message, 'error');
    }
  }

  async stopRecord() {
    if (!this.recording) return null;
    const rec = this.recording;
    this.recording = null;
    rec.stop();
    const { blob, mime, ext } = await rec.done;
    blob.name = `语音_${Date.now()}.${ext}`;
    blob.mime = mime;
    return blob;
  }

  setSub(text) {
    this.head.querySelector('#chat-sub').textContent = text || '';
  }

  setInputEnabled(enabled) {
    const dis = !enabled;
    this.textInput.disabled = dis;
    this.sendBtn.disabled = dis;
    this.fileBtn.disabled = dis;
    this.voiceBtn.disabled = dis;
  }

  /** 进入/退出多选模式（房主删除气泡用） */
  setSelectMode(on) {
    this.selectMode = !!on;
    this.selected.clear();
    for (const b of this.body.querySelectorAll('.msg:not(.system)')) this.renderCheckbox(b);
    this.onSelectChange?.();
  }

  renderCheckbox(bubble) {
    const old = bubble.querySelector('.msg-check');
    if (old) old.remove();
    if (!this.selectMode) return;
    const id = bubble.dataset.msgId;
    if (!id) return;
    const cb = el('label', { class: 'msg-check' }, [el('input', { type: 'checkbox' })]);
    cb.querySelector('input').checked = this.selected.has(id);
    cb.querySelector('input').addEventListener('change', () => {
      if (cb.querySelector('input').checked) this.selected.add(id);
      else this.selected.delete(id);
      this.onSelectChange?.();
    });
    bubble.prepend(cb);
  }

  /** 按 messageId 批量移除气泡（房主删除后同步） */
  removeMessages(ids) {
    const set = new Set(ids.map(String));
    for (const id of set) {
      const b = this.messageBubbles.get(id);
      if (!b) continue;
      if (b._fileId) {
        this.fileBubbles.delete(b._fileId);
        this.fileTransfers.delete(b._fileId);
      }
      b.remove();
      this.messageBubbles.delete(id);
    }
    this.selected.clear();
    if (this.selectMode) this.onSelectChange?.();
  }

  clear() {
    this.body.innerHTML = '';
    this.fileTransfers.clear();
    this.fileBubbles.clear();
    this.messageBubbles.clear();
    this.selected.clear();
  }

  addSystem(text) {
    this.body.append(el('div', { class: 'msg system', text }));
    if (this.isNearBottom()) this.scroll();
  }

  addMessage({ mine, sender, type, content, file, ts, messageId }, anchor = null) {
    const beforeH = anchor ? this.body.scrollHeight : 0;
    const beforeT = anchor ? this.body.scrollTop : 0;
    if (type === 'system') {
      const b = el('div', { class: 'msg system', text: content });
      if (anchor) this.body.insertBefore(b, anchor);
      else this.body.append(b);
      if (!anchor && this.isNearBottom()) this.scroll();
      return null;
    }
    const meta = mine ? null : el('div', { class: 'meta', text: sender || '' });
    const bubble = el('div', { class: `msg ${mine ? 'mine' : 'theirs'}` });
    if (messageId) {
      bubble.dataset.msgId = String(messageId);
      this.messageBubbles.set(String(messageId), bubble);
    }
    if (file?.id) bubble._fileId = file.id;
    if (meta) bubble.append(meta);
    if (file && file.status === 'deleted') {
      bubble.append(el('div', { class: 'muted', text: `${content || file.filename || '文件'} · 文件已删除` }));
      if (ts) bubble.append(el('div', { class: 'msg-time', text: fmtClock(ts) }));
    } else {
      if (type === 'text') {
        bubble.append(el('div', { text: content }));
      } else if (type === 'voice') {
        const wrap = file ? this.buildVoice(file) : el('span', { text: content || '语音' });
        bubble.append(wrap);
      } else if (type === 'image') {
        if (!file) {
          bubble.append(el('span', { text: content || '图片' }));
        } else if (!file.ready && file.scope === 'room') {
          bubble.append(el('span', { class: 'muted', text: '媒体处理中…' }));
        } else {
          const img = el('img', { class: 'thumb', alt: content || '图片' });
          img.addEventListener('click', () => openImageViewer(file));
          if (file.scope === 'room' && file.ready) {
            authedUrl(file.url.replace('/download', '/thumb')).catch(() => authedUrl(file.url)).then((u) => (img.src = u)).catch(() => {});
          } else {
            authedUrl(file.url).then((u) => (img.src = u)).catch(() => {});
          }
          bubble.append(img);
        }
      } else if (type === 'video') {
        if (!file) {
          bubble.append(el('span', { text: content || '视频' }));
        } else if (!file.ready && file.scope === 'room') {
          bubble.append(el('span', { class: 'muted', text: '媒体处理中…' }));
        } else {
          const v = el('video', { controls: true });
          v.preload = 'none';
          v.src = mediaUrl(file.url.replace('/download', '/preview'));
          v.addEventListener('error', () => {
            const orig = mediaUrl(file.url);
            if (v.src !== orig) v.src = orig;
          });
          bubble.append(v);
        }
      } else {
        bubble.append(file ? this.buildFileChip(file) : el('span', { text: content || '文件' }));
      }
    }
    if (ts) bubble.append(el('div', { class: 'msg-time', text: fmtClock(ts) }));
    if (file && type !== 'text') {
      this.fileBubbles.set(file.id, bubble);
      this.fileTransfers.set(file.id, { bubble, file, progress: el('div', { class: 'progress' }, [el('div')]) });
    }
    if (anchor) {
      if (anchor) this.body.insertBefore(bubble, anchor);
      this.body.scrollTop = beforeT + (this.body.scrollHeight - beforeH);
    } else {
      this.body.append(bubble);
      // 别人的消息只在接近底部时自动滚动，避免打断翻看记录/找文件
      if (mine || this.isNearBottom()) this.scroll();
    }
    return bubble;
  }

  /** 是否已接近聊天底部（用于决定新消息是否自动滚动） */
  isNearBottom() {
    return this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 160;
  }

  /** 媒体处理完成后更新气泡 */
  updateFile(file) {
    const bubble = this.fileBubbles.get(file.id);
    if (!bubble || !file) return;
    bubble.innerHTML = '';
    if (file.status === 'deleted') {
      bubble.append(el('div', { class: 'muted', text: `${file.filename || '文件'} · 文件已删除` }));
      this.scroll();
      return;
    }
    if (file.kind === 'image') {
      const img = el('img', { class: 'thumb', alt: file.filename });
      img.addEventListener('click', () => openImageViewer(file));
      if (file.scope === 'room' && file.ready) {
        authedUrl(file.url.replace('/download', '/thumb')).catch(() => authedUrl(file.url)).then((u) => (img.src = u)).catch(() => {});
      } else {
        authedUrl(file.url).then((u) => (img.src = u)).catch(() => {});
      }
      bubble.append(img);
    } else if (file.kind === 'video') {
      const v = el('video', { controls: true });
      v.preload = 'none';
      v.src = mediaUrl(file.url.replace('/download', '/preview'));
      v.addEventListener('error', () => {
        const orig = mediaUrl(file.url);
        if (v.src !== orig) v.src = orig;
      });
      bubble.append(v);
    } else if (file.kind === 'voice') {
      bubble.append(this.buildVoice(file));
    } else {
      bubble.append(this.buildFileChip(file));
    }
    this.scroll();
  }

  buildVoice(file) {
    const row = el('div', { class: 'file-chip voice-chip' }, [
      el('span', { class: 'voice-icon', text: '🎙️' }),
      el('span', { class: 'fname', text: file.filename || '语音' }),
    ]);
    const playBtn = el('button', { class: 'btn small', text: '▶ 播放' });
    const detailBtn = el('button', { class: 'btn secondary small', text: '详情' });
    row.append(playBtn, detailBtn);
    const audio = new Audio();
    audio.preload = 'none';
    row._audio = audio;
    const sync = () => {
      playBtn.textContent = audio.paused ? (audio.currentTime > 0 ? '▶ 继续' : '▶ 播放') : '⏸ 暂停';
    };
    audio.addEventListener('play', sync);
    audio.addEventListener('pause', sync);
    audio.addEventListener('ended', sync);
    audio.src = mediaUrl(file.url);
    playBtn.addEventListener('click', async () => {
      try {
        if (!audio.currentSrc) return toast('语音尚未加载完成，请稍后重试', 'error');
        if (audio.paused) await audio.play();
        else audio.pause();
      } catch (e) { toast(e.message, 'error'); }
    });
    detailBtn.addEventListener('click', () => openVoicePlayer(file, audio));
    return row;
  }

  buildFileChip(file) {
    const sizeTxt = file.size ? fmtBytes(file.size) : '';
    const chip = el('div', { class: 'file-chip' }, [
      el('span', { text: '📄' }),
      el('span', { class: 'fname', title: file.filename, text: `${file.filename}${sizeTxt ? ' (' + sizeTxt + ')' : ''}` }),
      el('button', {
        class: 'btn small',
        text: '下载',
        onClick: () => {
      saveRemoteFile(file, file.filename).catch((e) => toast(e.message, 'error'));
        },
      }),
    ]);
    return chip;
  }

  addTransfer(transferId, { file, mine }) {
    const p = el('div', { class: 'progress' }, [el('div')]);
    const cancelBtn = el('button', { class: 'btn danger small cancel-transfer', text: '取消' });
    cancelBtn.addEventListener('click', () => this.onCancelTransfer?.(transferId));
    const chip = el('div', { class: 'file-chip' }, [
      el('span', { text: '📄' }),
      el('span', { class: 'fname', text: `${file.name} (${fmtBytes(file.size)})` }),
      p,
      cancelBtn,
    ]);
    const bubble = el('div', { class: `msg ${mine ? 'mine' : 'theirs'}` }, [chip]);
    this.body.append(bubble);
    this.fileTransfers.set(transferId, { bubble, progress: p, file, cancelBtn });
    this.scroll();
  }

  setTransferProgress(transferId, ratio, label) {
    const t = this.fileTransfers.get(transferId);
    if (t) {
      t.progress.firstChild.style.width = `${Math.round(ratio * 100)}%`;
      if (label !== undefined) t.bubble.querySelector('.fname').textContent = label;
    }
  }

  setTransferCanceled(transferId, label = '已取消') {
    const t = this.fileTransfers.get(transferId);
    if (t) {
      t.cancelBtn?.remove();
      t.progress.firstChild.style.width = '0%';
      t.bubble.querySelector('.fname').textContent = label;
    }
  }

  removeTransfer(transferId) {
    const t = this.fileTransfers.get(transferId);
    if (t) t.bubble.remove();
    this.fileTransfers.delete(transferId);
  }

  scroll() {
    this.body.scrollTop = this.body.scrollHeight;
  }
}
