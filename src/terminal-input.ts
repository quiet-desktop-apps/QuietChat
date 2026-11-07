import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/** Convert modern terminal key reports for neo-blessed's legacy key decoder. */
export function legacyKey(code: number, modifiers = 1, event = 1): string {
  if (event === 3) return ''; // Key release, not another keystroke.
  const bits = modifiers - 1, shift = !!(bits & 1), alt = !!(bits & 2), ctrl = !!(bits & 4);
  if (code === 13) return shift ? '\n' : '\r';
  if (code === 9 && shift) return '\x1b[Z';
  if (code > 0x10ffff || code < 0 || (code >= 57344 && code <= 63743)) return '';
  let text = String.fromCodePoint(code);
  if (ctrl && code >= 97 && code <= 122) text = String.fromCharCode(code - 96);
  else if (ctrl && code >= 64 && code <= 95) text = String.fromCharCode(code - 64);
  else if (ctrl && code === 32) text = '\0';
  return (alt ? '\x1b' : '') + text;
}

export class TerminalInput extends Transform {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private paste: string | undefined;
  private escapeTimer?: NodeJS.Timeout;
  constructor(private readonly source?: NodeJS.ReadStream) {
    super();
    source?.pipe(this);
  }
  get isTTY(): boolean { return this.source?.isTTY ?? false; }
  get isRaw(): boolean { return this.source?.isRaw ?? false; }
  setRawMode(value: boolean): this { this.source?.setRawMode(value); return this; }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    clearTimeout(this.escapeTimer);
    this.pending += this.decoder.write(chunk);
    this.parse();
    // Escape alone remains usable; split CSI sequences get time to finish.
    if (this.pending === '\x1b') this.escapeTimer = setTimeout(() => { this.push(this.pending); this.pending = ''; }, 40);
    done();
  }
  private parse(): void {
    let output = '';
    while (this.pending) {
      if (this.paste !== undefined) {
        const end = this.pending.indexOf('\x1b[201~');
        if (end < 0) {
          // Retain the possible split closing marker, with a bounded paste buffer.
          const keep = Math.min(5, this.pending.length);
          this.paste = (this.paste + this.pending.slice(0, this.pending.length - keep)).slice(0, 16000);
          this.pending = this.pending.slice(this.pending.length - keep);
          break;
        }
        const text = (this.paste + this.pending.slice(0, end)).slice(0, 16000);
        this.pending = this.pending.slice(end + 6); this.paste = undefined;
        if (output) { this.push(output); output = ''; }
        this.emit('paste', text);
        continue;
      }
      const escape = this.pending.indexOf('\x1b');
      if (escape !== 0) {
        const count = escape < 0 ? this.pending.length : escape;
        output += this.pending.slice(0, count); this.pending = this.pending.slice(count); continue;
      }
      if (this.pending.length === 1) break;
      if (!this.pending.startsWith('\x1b[')) {
        output += this.pending.slice(0, 2); this.pending = this.pending.slice(2); continue;
      }
      const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(this.pending);
      if (!match) {
        if (this.pending.length > 128) { this.pending = ''; }
        break;
      }
      let sequence = match[0];
      if (sequence === '\x1b[M') {
        if (this.pending.length < 6) break;
        sequence = this.pending.slice(0, 6);
      }
      this.pending = this.pending.slice(sequence.length);
      if (sequence === '\x1b[200~') { this.paste = ''; continue; }
      const kitty = /^\x1b\[(\d+)(?::\d+)*(?:;(\d+)(?::(\d+))?)?u$/.exec(sequence);
      const xterm = /^\x1b\[27;(\d+);(\d+)~$/.exec(sequence);
      if (kitty) output += legacyKey(Number(kitty[1]), Number(kitty[2] || 1), Number(kitty[3] || 1));
      else if (xterm) output += legacyKey(Number(xterm[2]), Number(xterm[1]));
      else output += sequence;
    }
    if (output) this.push(output);
  }
  disconnect(): void { clearTimeout(this.escapeTimer); this.source?.unpipe(this); }
}
