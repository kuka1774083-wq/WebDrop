export async function recordAudio() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前环境不支持麦克风录制（需要 HTTPS 或 localhost），请改用文件上传');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm';
  const rec = new MediaRecorder(stream, mime === 'audio/mp4' ? { mimeType: 'audio/mp4', audioBitsPerSecond: 128000 } : { mimeType: 'audio/webm' });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const type = rec.mimeType || mime;
      resolve({
        blob: new Blob(chunks, { type }),
        mime: type,
        ext: type.includes('mp4') ? 'm4a' : 'webm',
      });
    };
    rec.onerror = (e) => reject(e.error || new Error('录制失败'));
  });
  rec.start();
  return { rec, stop: () => rec.state !== 'inactive' && rec.stop(), done };
}
