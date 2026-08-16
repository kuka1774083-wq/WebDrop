import { toast } from './util.js';

let storeRef = null;
export function setStore(s) {
  storeRef = s;
}

export function authHeaders(extra = {}) {
  const h = { ...extra };
  if (storeRef?.token) h.Authorization = `Bearer ${storeRef.token}`;
  if (storeRef?.tempId) h['x-temp-id'] = storeRef.tempId;
  return h;
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const opts = { method, headers: authHeaders(headers) };
  if (body !== undefined) {
    if (body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array) {
      opts.body = body;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function uploadWithProgress(path, file, { headers = {}, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    const h = authHeaders(headers);
    for (const [k, v] of Object.entries(h)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      try {
        const d = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(d);
        else reject(new Error(d.error || `上传失败 (${xhr.status})`));
      } catch {
        reject(new Error('上传失败'));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(file);
  });
}

export async function downloadBlob(path, { headers = {} } = {}) {
  const res = await fetch(path, { headers: authHeaders(headers) });
  if (!res.ok) {
    let msg = `下载失败 (${res.status})`;
    try {
      const d = await res.json();
      if (d.error) msg = d.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.blob();
}

/** 流式下载：支持进度回调与取消（AbortController） */
export async function fetchWithProgress(path, { headers = {}, signal, onProgress } = {}) {
  const res = await fetch(path, { headers: authHeaders(headers), signal });
  if (!res.ok) {
    let msg = `下载失败 (${res.status})`;
    try {
      const d = await res.json();
      if (d.error) msg = d.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const total = Number(res.headers.get('content-length') || 0);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (onProgress) onProgress(total ? received / total : null);
  }
  return new Blob(chunks, { type: res.headers.get('content-type') || '' });
}
