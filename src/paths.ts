import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function dataDirectory(override?: string): string {
  const dir = resolve(override ?? join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'quietchat'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}
export function acquireLock(dir: string): () => void {
  const path = join(dir, 'instance.lock');
  const own = `${process.pid}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, own); closeSync(fd);
      return () => { if (existsSync(path) && readFileSync(path, 'utf8') === own) unlinkSync(path); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid instance lock. Check that QuietChat is closed before removing instance.lock.');
      try { process.kill(pid, 0); } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(path); continue; }
      }
      throw new Error('QuietChat is already running for this data directory.');
    }
  }
  throw new Error('Could not acquire the QuietChat instance lock.');
}
