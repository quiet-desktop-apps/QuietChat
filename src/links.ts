import { spawn } from 'node:child_process';

export type WebLink = { start: number; end: number; url: string };
export function webLinks(text: string): WebLink[] {
  const links: WebLink[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let url = match[0].replace(/[.,;:!]+$/, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
    }
    try {
      const parsed = new URL(url);
      if (parsed.hostname && ['http:', 'https:'].includes(parsed.protocol)) links.push({ start: match.index, end: match.index + url.length, url });
    } catch { /* A URL-looking fragment is plain text if it is not valid. */ }
  }
  return links;
}

export async function openWebLink(url: string): Promise<void> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || /[\x00-\x20\x7f]/.test(url)) throw new Error('Only HTTP and HTTPS links can be opened.');
  await new Promise<void>((resolve, reject) => {
    // URL is one argument, never shell input; clicking opens the system browser.
    const child = spawn('xdg-open', [url], { stdio: 'ignore', shell: false });
    child.once('error', () => reject(new Error('Could not start the default browser (xdg-open).')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('The default browser could not open this link.')));
  });
}
