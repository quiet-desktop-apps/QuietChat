import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, stat, unlink, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Attachment } from './model.js';

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
export const CACHE_BYTES = 256 * 1024 * 1024;

export async function inspectAttachment(input: string): Promise<Attachment> {
  const path = resolve(input.startsWith('~/') ? join(homedir(), input.slice(2)) : input);
  const info = await stat(path);
  if (!info.isFile()) throw new Error('Choose an image or video file.');
  if (!info.size || info.size > MAX_MEDIA_BYTES) throw new Error('This prototype accepts files between 1 byte and 100 MiB.');
  const file = await open(path, 'r');
  const header = Buffer.alloc(32);
  try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
  let kind: Attachment['kind'], mime: string;
  if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) { kind = 'image'; mime = 'image/jpeg'; }
  else if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { kind = 'image'; mime = 'image/png'; }
  else if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') { kind = 'image'; mime = 'image/webp'; }
  else if (header.toString('ascii', 4, 8) === 'ftyp' && /^(isom|iso[2-9]|mp4[12]|avc1|M4V )$/.test(header.toString('ascii', 8, 12))) { kind = 'video'; mime = 'video/mp4'; }
  else throw new Error('Supported files: JPEG, PNG, WebP images and MP4 video. Convert other formats first.');
  return { path, size: info.size, kind, mime };
}

export class MediaCache {
  constructor(readonly directory: string, readonly budget = CACHE_BYTES, readonly maxFile = MAX_MEDIA_BYTES) {}
  path(chat: string, id: string, kind: 'image' | 'video'): string {
    return join(this.directory, createHash('sha256').update(`${chat}\0${id}`).digest('hex') + (kind === 'image' ? '.img' : '.mp4'));
  }
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory)) if (name.endsWith('.part')) await unlink(join(this.directory, name));
    await this.prune();
  }
  async cached(path: string): Promise<boolean> {
    try { await stat(path); await utimes(path, new Date(), new Date()); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async save(path: string, stream: Readable, signal?: AbortSignal): Promise<string> {
    const partial = `${path}.part`;
    let bytes = 0;
    const limit = new Transform({ transform: (chunk: Buffer, _encoding, next) => {
      bytes += chunk.length;
      next(bytes > this.maxFile ? new Error('Media exceeds the 100 MiB download limit.') : null, chunk);
    } });
    try {
      await pipeline(stream, limit, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal });
      if (!bytes) throw new Error('The downloaded attachment is empty.');
      await rename(partial, path);
      await this.prune(path);
      return path;
    } catch (error) { await unlink(partial).catch(() => {}); throw error; }
  }
  async prune(keep?: string): Promise<void> {
    const files = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.(img|mp4)$/.test(name)) continue;
      const path = join(this.directory, name), info = await stat(path);
      files.push({ path, size: info.size, time: info.mtimeMs });
    }
    let total = files.reduce((n, file) => n + file.size, 0);
    for (const file of files.sort((a, b) => a.time - b.time)) {
      if (total <= this.budget) break;
      if (file.path !== keep) { await unlink(file.path); total -= file.size; }
    }
  }
  async remove(chat: string, id: string): Promise<void> {
    await Promise.all(['image', 'video'].map(kind => unlink(this.path(chat, id, kind as 'image' | 'video')).catch(() => {})));
  }
  async clear(): Promise<void> {
    for (const name of await readdir(this.directory)) {
      if (/^[a-f0-9]{64}\.(img|mp4)(\.part)?$/.test(name)) await unlink(join(this.directory, name));
    }
  }
}

// Never pass paths, filenames or chat text through a shell.
export class Viewer {
  private child?: ChildProcess;
  constructor(private readonly onError: (message: string) => void) {}
  open(path: string, kind: 'image' | 'video'): void {
    this.close();
    const args = ['--no-config', '--force-window=yes', '--title=QuietChat', '--really-quiet'];
    if (kind === 'image') args.push('--image-display-duration=inf');
    const child = spawn('mpv', [...args, '--', path], { stdio: 'ignore', shell: false });
    this.child = child;
    child.on('error', () => this.onError('Cannot start mpv. Install mpv to open images and videos.'));
    child.on('exit', code => {
      if (this.child === child) { this.child = undefined; if (code && code !== 0) this.onError('mpv could not open this media file.'); }
    });
  }
  close(): void { const previous = this.child; this.child = undefined; previous?.kill(); }
}

export async function chooseFile(): Promise<string | undefined> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('zenity', ['--file-selection', '--title=QuietChat — choose an image or video'], { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => { if (output.length < 16384) output += text; });
    child.on('error', () => reject(new Error('File picker unavailable. Use F4 to type a file path.')));
    child.on('close', code => { if (code === 0) resolveResult(output.replace(/\r?\n$/, '')); else if (code === 1) resolveResult(undefined); else reject(new Error('File picker unavailable. Use F4 to type a file path.')); });
  });
}
