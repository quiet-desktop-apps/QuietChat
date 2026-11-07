import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';

const MAX_FETCH = 512 * 1024;
export function publicAddress(address: string): boolean {
  if (address.includes(':')) return !/^(::|fc|fd|fe[89ab]|ff)/i.test(address) && !address.toLowerCase().startsWith('::ffff:');
  const [a,b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127);
}
export async function boundedFetch(input: string, accept: string): Promise<Buffer> {
  let url = input;
  const signal = AbortSignal.timeout(8000);
  for (let redirect = 0; redirect < 4; redirect++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw new Error('Preview requires a public HTTPS URL.');
    const addresses = await lookup(parsed.hostname.replace(/^\[|\]$/g, ''), { all: true });
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('Private network previews are not loaded.');
    const response = await fetch(url, { redirect: 'manual', signal, headers: { Accept: accept, 'User-Agent': 'QuietChat/0.2' } });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      url = new URL(response.headers.get('location') || '', url).href; continue;
    }
    if (!response.ok || !response.body) throw new Error('Preview is unavailable.');
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_FETCH) throw new Error('Preview exceeded its size limit.');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } finally { if (!response.body.locked) await response.body.cancel().catch(() => {}); }
  }
  throw new Error('Too many preview redirects.');
}

export class NativeAssets {
  private jobs = 0;
  constructor(readonly directory: string) {}
  async init(): Promise<void> { await mkdir(this.directory, { recursive: true, mode: 0o700 }); await this.prune(); }
  path(key: string): string { return join(this.directory, createHash('sha256').update(key).digest('hex') + '.png'); }
  async cached(key: string): Promise<string | undefined> {
    const path = this.path(key);
    try { if (Date.now() - (await stat(path)).mtimeMs < 86400_000) return path; } catch {}
  }
  async thumbnail(key: string, input: string | Buffer): Promise<string> {
    const cached = await this.cached(key); if (cached) return cached;
    if (this.jobs >= 2) throw new Error('Preview queue is busy. Try again in a moment.');
    this.jobs++;
    const path = this.path(key), temporary = path + '.source';
    try {
      if (Buffer.isBuffer(input)) { if (input.length > MAX_FETCH) throw new Error('Thumbnail is too large.'); await writeFile(temporary, input, { mode: 0o600 }); }
      await new Promise<void>((resolve, reject) => {
        const child = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '1', '-max_alloc', '33554432', '-i', Buffer.isBuffer(input) ? temporary : input,
          '-frames:v', '1', '-vf', 'scale=480:320:force_original_aspect_ratio=decrease', '-threads', '1', '-y', path], { stdio: 'ignore', timeout: 10_000 });
        child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('This image cannot be previewed.')));
      });
      await this.prune(path); return path;
    } catch (error) {
      await unlink(path).catch(() => {}); throw error;
    } finally { this.jobs--; await unlink(temporary).catch(() => {}); }
  }
  async prune(keep?: string): Promise<void> {
    const files = await Promise.all((await readdir(this.directory)).filter(n => /^[a-f0-9]{64}\.png$/.test(n)).map(async n => ({ path: join(this.directory,n), ...(await stat(join(this.directory,n))) })));
    files.sort((a,b) => b.mtimeMs - a.mtimeMs);
    let total = 0;
    for (let i = 0; i < files.length; i++) {
      total += files[i].size;
      if ((i >= 200 || total > 16 * 1024 * 1024) && files[i].path !== keep) await unlink(files[i].path).catch(() => {});
    }
  }
}

export function pageMetadata(html: string, source: string): { url: string; title: string; description: string; image?: string } {
  const decode = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
  const tags = new Map<string,string>();
  for (const tag of html.matchAll(/<meta\s[^>]{0,4000}>/gi)) {
    const attrs = new Map([...tag[0].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(m => [m[1].toLowerCase(), decode(m[3])]));
    const key = attrs.get('property') || attrs.get('name'); if (key) tags.set(key.toLowerCase(), attrs.get('content') || '');
  }
  const image = tags.get('og:image');
  return { url: source, title: (tags.get('og:title') || decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '') || new URL(source).hostname).slice(0,160),
    description: (tags.get('og:description') || tags.get('description') || '').slice(0,400), image: image ? new URL(image, source).href : undefined };
}
