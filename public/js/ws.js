export function makeFrame(header, payload) {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const buf = new ArrayBuffer(4 + h.byteLength + (payload ? payload.byteLength : 0));
  const view = new DataView(buf);
  view.setUint32(0, h.byteLength);
  new Uint8Array(buf, 4, h.byteLength).set(h);
  if (payload) new Uint8Array(buf, 4 + h.byteLength).set(payload);
  return buf;
}

export function parseFrame(buf) {
  const view = new DataView(buf);
  const len = view.getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len)));
  return { header, payload: new Uint8Array(buf.slice(4 + len)) };
}

export class WsClient {
  constructor({ tempId, token, deviceId = '', deviceInfo = {} }) {
    this.tempId = tempId;
    this.token = token;
    this.deviceId = deviceId;
    this.deviceInfo = deviceInfo;
    this.listeners = new Map();
    this.ws = null;
    this.stopped = false;
    this.retry = 0;
    this.gen = 0;
    this.keepAliveTimer = null;
    this.onResume = null; // 页面回到前台时回调（检查对方在线/补拉消息）
    this.filePickActive = false; // 系统文件选择器是否打开（用于桌面端取消选择后的兜底恢复）
    this.visibilityHandler = () => {
      if (document.visibilityState !== 'visible' || this.stopped) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.connect();
      } else {
        this.send({ type: 'ping' }); // 回到前台立即确认连接存活
      }
      this.onResume?.();
    };
    this.focusHandler = () => {
      // 桌面端：文件选择器关闭（含取消）时窗口重新获得焦点，兜底恢复心跳并同步会话
      if (this.stopped || !this.filePickActive) return;
      this.setFilePick(false);
      this.onResume?.();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('focus', this.focusHandler);
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
    return () => {
      const arr = this.listeners.get(type) || [];
      this.listeners.set(type, arr.filter((f) => f !== fn));
    };
  }

  emit(type, data) {
    for (const fn of this.listeners.get(type) || []) {
      try { fn(data); } catch (e) { console.error(e); }
    }
  }

  connect() {
    const gen = ++this.gen;
    if (!this.keepAliveTimer) {
      this.keepAliveTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ type: 'ping' });
      }, 30000);
    }
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    this.ws = new WebSocket(`${proto}${location.host}/ws`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this.retry = 0;
      this.send({
        type: 'hello',
        tempId: this.tempId,
        token: this.token || undefined,
        deviceId: this.deviceId,
        deviceInfo: this.deviceInfo,
      });
      this.emit('open');
    };
    this.ws.onmessage = (e) => this.handleMessage(e.data);
    this.ws.onclose = () => {
      this.emit('close');
      if (!this.stopped && gen === this.gen) {
        const delay = Math.min(10000, 1000 * 2 ** this.retry++);
        setTimeout(() => this.connect(), delay);
      }
    };
    this.ws.onerror = () => this.ws && this.ws.close();
  }

  stop() {
    this.stopped = true;
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    window.removeEventListener('focus', this.focusHandler);
    try { this.ws && this.ws.close(); } catch { /* ignore */ }
  }

  /** 文件选择器开/关：打开时放宽服务端心跳，关闭时立即恢复 */
  setFilePick(active) {
    this.filePickActive = !!active;
    this.send({ type: 'filePick', active: !!active });
  }

  handleMessage(data) {
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      this.emit(msg.type, msg);
      return;
    }
    try {
      const { header, payload } = parseFrame(data);
      this.emit(header.type, { ...header, payload });
    } catch { /* ignore */ }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendBinary(header, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(makeFrame(header, payload));
    }
  }

  /** 登录/注销后更新身份并立即重连 */
  setToken(token) {
    this.token = token || '';
    this.retry = 0;
    try { this.ws && this.ws.close(); } catch { /* ignore */ }
    this.connect();
  }
}
