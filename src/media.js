import { spawn } from 'node:child_process';
import fs from 'node:fs';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => {
      err += d;
    });
    p.on('error', (e) => reject(e));
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`));
    });
  });
}

export function ffmpegAvailable() {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

export async function makeImageThumb(src, out) {
  await runFfmpeg([
    '-y', '-i', src,
    '-vf', "scale='min(320,iw)':-2",
    '-frames:v', '1', '-q:v', '5',
    out,
  ]);
}

export async function makeVideoThumb(src, out) {
  await runFfmpeg([
    '-y', '-ss', '1', '-i', src,
    '-vf', "scale='min(320,iw)':-2",
    '-frames:v', '1', '-q:v', '5',
    out,
  ]);
}

export async function makeVideoPreview(src, out) {
  await runFfmpeg([
    '-y', '-i', src,
    '-vf', "scale='min(854,iw)':-2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
    '-c:a', 'aac', '-b:a', '64k',
    '-movflags', '+faststart',
    out,
  ]);
}

/** 音频压缩/转码为 m4a (AAC) */
export async function toM4a(src, out) {
  await runFfmpeg([
    '-y', '-i', src,
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    out,
  ]);
}

export async function probeDuration(src) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'json',
      src,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      try {
        const j = JSON.parse(out);
        resolve(Number(j.format?.duration) || null);
      } catch {
        resolve(null);
      }
    });
  });
}

export function removeIfExists(p) {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    // ignore
  }
}
