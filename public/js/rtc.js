export const CHUNK = 64 * 1024;
const WINDOW = 96;
export const ACK_EVERY = 16;

export function makeRtcFrame(header, payload) {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const buf = new ArrayBuffer(4 + h.byteLength + (payload ? payload.byteLength : 0));
  const view = new DataView(buf);
  view.setUint32(0, h.byteLength);
  new Uint8Array(buf, 4, h.byteLength).set(h);
  if (payload) new Uint8Array(buf, 4 + h.byteLength).set(payload);
  return buf;
}

/** 从 candidate 字符串中解析 IP */
export function parseCandidateIp(candidateStr) {
  const parts = String(candidateStr || '').split(' ');
  if (parts[0] && parts[0].startsWith('candidate:') && parts.length >= 5) return parts[4];
  return null;
}

/** 是否为私有/内网地址 */
export function isPrivateIp(ip) {
  if (!ip) return false;
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    return (
      lower.startsWith('fd') ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb') ||
      lower === '::1'
    );
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  if (p[0] === 10) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 127) return true;
  return false;
}

/** IPv4 取 /24，IPv6 取前 4 段（/64）作为子网标识 */
export function subnetOf(ip) {
  if (!ip) return null;
  if (ip.includes(':')) {
    const groups = ip.split(':');
    if (groups[0] === '' && groups[1] === '') return '::';
    const s = groups.slice(0, 4).join(':');
    return s ? s.toLowerCase() : null;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return parts.slice(0, 3).join('.');
}

/** 双方网络信息是否存在同一子网 */
export function hasMatchingSubnet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const set = new Set(a.map((x) => x && x.subnet).filter(Boolean));
  return b.some((x) => x && set.has(x.subnet));
}

/** 通过 WebRTC 探针收集本机私有地址列表 */
export async function detectNetworkInfo(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const out = [];
    let pc = null;
    const finish = () => {
      clearTimeout(timer);
      try { pc && pc.close(); } catch { /* ignore */ }
      resolve(out);
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('probe');
      pc.onicecandidate = (e) => {
        if (!e.candidate) return finish();
        const ip = parseCandidateIp(e.candidate.candidate);
        if (isPrivateIp(ip) && !out.some((x) => x.ip === ip)) {
          out.push({ ip, subnet: subnetOf(ip) });
        }
      };
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .catch(() => finish());
    } catch {
      finish();
    }
  });
}

export class SessionRTC {
  constructor({ sessionId, ws, onState, onFrame, lan = false, peerSubnets = [], onLan }) {
    this.sessionId = sessionId;
    this.ws = ws;
    this.onState = onState;
    this.onFrame = onFrame;
    this.onLan = onLan;
    this.lan = lan;
    this.peerSubnets = peerSubnets;
    this.pendingCandidates = [];
    this.pendingTimer = null;
    this.pc = new RTCPeerConnection({ iceServers: [] });
    this.dc = null;
    this.up = false;
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.ws.send({ type: 'signal', sessionId, payload: { candidate: e.candidate.toJSON() } });
      }
    };
    this.pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected'].includes(this.pc.connectionState) && !this.up) {
        this.ws.send({ type: 'useRelay', sessionId });
        this.onState('relay');
      }
    };
    this.pc.ondatachannel = (e) => this.setupChannel(e.channel);
  }

  setupChannel(dc) {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      this.up = true;
      this.ws.send({ type: 'p2pUp', sessionId: this.sessionId });
      this.onState('p2p');
      this.checkLan();
    };
    dc.onclose = () => {
      if (this.up) this.onState('closed');
    };
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try { this.onFrame(JSON.parse(e.data), null); } catch { /* ignore */ }
      } else {
        this.onFrame(null, e.data);
      }
    };
  }

  async createOffer() {
    this.dc = this.pc.createDataChannel('wd');
    this.setupChannel(this.dc);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async acceptOffer(offer) {
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async onSignal(payload) {
    if (payload.candidate) {
      const ip = parseCandidateIp(payload.candidate.candidate);
      const subnet = subnetOf(ip);
      const lanMatch = this.lan && subnet && this.peerSubnets.includes(subnet);
      if (!this.lan || lanMatch) {
        try {
          await this.pc.addIceCandidate(payload.candidate);
        } catch { /* ignore */ }
        return;
      }
      // 同一局域网：优先应用局域网候选，非局域网候选延后
      this.pendingCandidates.push(payload.candidate);
      if (!this.pendingTimer) {
        this.pendingTimer = setTimeout(() => {
          this.pendingTimer = null;
          const q = this.pendingCandidates;
          this.pendingCandidates = [];
          for (const c of q) {
            try { this.pc.addIceCandidate(c); } catch { /* ignore */ }
          }
        }, 800);
      }
    }
  }

  close() {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pendingCandidates = [];
    try { this.dc && this.dc.close(); } catch { /* ignore */ }
    try { this.pc.close(); } catch { /* ignore */ }
  }

  sendText(text, mid) {
    if (this.up && this.dc && this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify(mid ? { type: 'text', content: text, mid } : { type: 'text', content: text }));
    }
  }

  sendFrame(header, payload) {
    if (this.up && this.dc && this.dc.readyState === 'open') {
      this.dc.send(makeRtcFrame(header, payload));
      return true;
    }
    return false;
  }

  /** 连接建立后通过 stats 确认：成功候选对两端都是 host（局域网/本机直连） */
  async checkLan() {
    try {
      const stats = await this.pc.getStats();
      let pair = null;
      stats.forEach((v) => {
        if (v.type === 'candidate-pair' && v.state === 'succeeded' && !pair) {
          pair = { lc: stats.get(v.localCandidateId), rc: stats.get(v.remoteCandidateId) };
        }
      });
      if (pair && pair.lc?.candidateType === 'host' && pair.rc?.candidateType === 'host') {
        this.lan = true;
        this.onLan?.({ local: pair.lc.address, remote: pair.rc.address });
      }
    } catch { /* ignore */ }
  }
}

/** 大文件传输（>10M）：控制走服务器 WS，数据走 P2P DC 或服务器中转 */
export class BigTransfer {
  constructor({ session, ws, rtc }) {
    this.session = session;
    this.ws = ws;
    this.rtc = rtc;
    this.transferId = `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.chunk = CHUNK;
    this.sent = 0;
    this.acked = 0;
    this.seq = 0;
    this.unacked = 0;
    this.started = false;
    this.canceled = false;
    this.pumping = false;
  }

  cancel() {
    this.canceled = true;
  }

  async start(file) {
    this.file = file;
    this.total = file.size;
    this.ws.send({
      type: 'fileOffer',
      sessionId: this.session.id,
      transferId: this.transferId,
      name: file.name,
      size: file.size,
      mime: file.type,
      kind: file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'voice' : 'file',
    });
    return this.transferId;
  }

  async pump() {
    // 防重入：await 期间收到 ACK 再次进入会导致同一序号分片被重复发送
    if (this.canceled || this.pumping || !this.started) return;
    this.pumping = true;
    try {
      while (!this.canceled && this.unacked < WINDOW && this.seq * this.chunk < this.total) {
        const start = this.seq * this.chunk;
        const end = Math.min(start + this.chunk, this.total);
        const blob = this.file.slice(start, end);
        const buf = await blob.arrayBuffer();
        const done = end >= this.total;
        const header = { type: 'fileChunk', sessionId: this.session.id, transferId: this.transferId, seq: this.seq, done };
        const ok = this.rtc && this.rtc.up ? this.rtc.sendFrame(header, new Uint8Array(buf)) : (this.ws.sendBinary(header, new Uint8Array(buf)), true);
        if (!ok) break;
        this.seq++;
        this.unacked++;
        this.sent = end;
        this.onProgress?.(this.sent / this.total);
        if (done) {
          this.onDone?.();
          return;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  onAck() {
    this.unacked = Math.max(0, this.unacked - ACK_EVERY);
    this.pump();
  }
}
